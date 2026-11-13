import Foundation

/// Supabase Realtime for Messages: tells the screens when a row in `messages` or `message_reactions` changed, as the web does
/// (`postgres_changes`, the whole table: row-level security decides which rows this person is sent). It speaks the small Phoenix
/// channel protocol that Realtime uses, over a WebSocket, and only says "something changed": the screens then fetch what they
/// show, exactly like the web. A 30 second poll in MessagesStore stays as the safety net for a dropped connection.
final class LiveFeed {
    var onChange: (() -> Void)?

    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private var heartbeat: Timer?
    private var rejoin: Timer?
    private var reconnectAttempt = 0
    private var running = false
    private var ref = 0
    private let topic = "realtime:messages-feed"

    func start() {
        guard !running else { return }
        running = true
        connect()
    }

    func stop() {
        running = false
        teardown()
    }

    /// The app came back to the front: the socket may have been cut while it was away.
    func reconnectNow() {
        guard running else { return }
        teardown()
        reconnectAttempt = 0
        connect()
    }

    private func teardown() {
        heartbeat?.invalidate(); heartbeat = nil
        rejoin?.invalidate(); rejoin = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        session?.invalidateAndCancel()
        session = nil
    }

    private func connect() {
        Task { [weak self] in
            guard let self, self.running else { return }
            guard let info = try? await NativeSession.shared.validSession() else { self.scheduleReconnect(); return }
            await MainActor.run { self.open(info) }
        }
    }

    @MainActor private func open(_ info: NativeSession.Info) {
        guard running else { return }
        teardown()
        var components = URLComponents(url: info.url.appendingPathComponent("realtime/v1/websocket"), resolvingAgainstBaseURL: false)!
        components.scheme = info.url.scheme == "https" ? "wss" : "ws"
        components.queryItems = [URLQueryItem(name: "apikey", value: info.key), URLQueryItem(name: "vsn", value: "1.0.0")]
        let session = URLSession(configuration: .default)
        let task = session.webSocketTask(with: components.url!)
        self.session = session
        self.task = task
        task.resume()

        let join: [String: Any] = [
            "config": [
                "broadcast": ["ack": false, "self": false],
                "presence": ["key": ""],
                "postgres_changes": [
                    ["event": "*", "schema": "public", "table": "messages"],
                    ["event": "*", "schema": "public", "table": "message_reactions"],
                ],
                "private": false,
            ],
            "access_token": info.accessToken,
        ]
        send(event: "phx_join", payload: join, joinRef: true)
        receive(task)

        heartbeat = Timer.scheduledTimer(withTimeInterval: 25, repeats: true) { [weak self] _ in
            self?.send(topic: "phoenix", event: "heartbeat", payload: [:])
        }
        // A token lives about an hour and the channel is authorised with the one it joined with: join again with a fresh one.
        rejoin = Timer.scheduledTimer(withTimeInterval: 20 * 60, repeats: true) { [weak self] _ in self?.reconnectNow() }
    }

    private func send(topic: String? = nil, event: String, payload: [String: Any], joinRef: Bool = false) {
        ref += 1
        var message: [String: Any] = ["topic": topic ?? self.topic, "event": event, "payload": payload, "ref": String(ref)]
        if joinRef { message["join_ref"] = String(ref) }
        guard let data = try? JSONSerialization.data(withJSONObject: message), let text = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(text)) { _ in }
    }

    private func receive(_ socket: URLSessionWebSocketTask) {
        socket.receive { [weak self] result in
            guard let self, socket === self.task else { return }
            switch result {
            case .failure:
                DispatchQueue.main.async { self.scheduleReconnect() }
            case .success(let message):
                if case .string(let text) = message, let data = text.data(using: .utf8),
                   let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let event = object["event"] as? String {
                    switch event {
                    case "postgres_changes": DispatchQueue.main.async { self.reconnectAttempt = 0; self.onChange?() }
                    case "phx_reply":
                        if let payload = object["payload"] as? [String: Any], payload["status"] as? String == "error" {
                            FrameLog.event("live feed: join refused")
                        } else { DispatchQueue.main.async { self.reconnectAttempt = 0 } }
                    case "phx_close", "phx_error": DispatchQueue.main.async { self.scheduleReconnect() }
                    default: break
                    }
                }
                self.receive(socket)
            }
        }
    }

    private func scheduleReconnect() {
        guard running else { return }
        teardown()
        reconnectAttempt += 1
        let delay = min(60, pow(2, Double(min(reconnectAttempt, 6))))
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, self.running, self.task == nil else { return }
            self.connect()
        }
    }
}

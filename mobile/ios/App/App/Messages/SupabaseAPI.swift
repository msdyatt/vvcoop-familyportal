import Foundation

/// Talks to Supabase as the signed-in person, the way the website does: PostgREST for tables and RPCs, Storage for files,
/// with the person's own token, so row-level security decides what comes back. No keys are kept in the app: the project
/// URL and publishable key arrive with the session (NativeSession).
struct SupabaseAPI {
    struct Failure: Error, LocalizedError {
        let message: String
        let status: Int
        var errorDescription: String? { message }
    }

    static let shared = SupabaseAPI()
    static let bucket = "family-village-private"

    /// Decoders are deliberately created per response. JSONDecoder is mutable while decoding and the Messages
    /// store can have several requests in flight at once (list, unread badge, people and thread data).
    private static func makeDecoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }

    private let session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 30
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration)
    }()

    // MARK: Requests

    /// Sends a request with the person's token. A 401 means the token ran out between asking and arriving: get a fresh one once.
    func send(_ path: String, method: String = "GET", query: [URLQueryItem] = [], body: Data? = nil,
              headers: [String: String] = [:], contentType: String? = "application/json") async throws -> (Data, HTTPURLResponse) {
        var forced = false
        while true {
            let info = try await NativeSession.shared.validSession(force: forced)
            var components = URLComponents(url: info.url.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
            if !query.isEmpty {
                components.queryItems = query
                // A "+" in a timestamp ("...+00:00") would be read as a space by the server.
                components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
            }
            var request = URLRequest(url: components.url!)
            request.httpMethod = method
            request.httpBody = body
            request.setValue(info.key, forHTTPHeaderField: "apikey")
            request.setValue("Bearer \(info.accessToken)", forHTTPHeaderField: "Authorization")
            if let contentType, body != nil { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw Failure(message: "No answer from the server.", status: 0) }
            if http.statusCode == 401 && !forced { forced = true; continue }
            guard (200..<300).contains(http.statusCode) else { throw Self.failure(data, status: http.statusCode) }
            return (data, http)
        }
    }

    /// PostgREST errors are `{ "message": "...", "hint": ... }`; the message is written for people (the database raises them).
    private static func failure(_ data: Data, status: Int) -> Failure {
        if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let message = object["message"] as? String, !message.isEmpty {
            return Failure(message: message, status: status)
        }
        return Failure(message: status == 401 ? "Please sign in again." : "Something went wrong (\(status)).", status: status)
    }

    // MARK: Database

    func rpc<T: Decodable>(_ name: String, _ params: [String: Any] = [:], as type: T.Type = T.self) async throws -> T {
        let body = try JSONSerialization.data(withJSONObject: params)
        let (data, _) = try await send("rest/v1/rpc/\(name)", method: "POST", body: body)
        return try Self.decodeBody(data)
    }

    /// An RPC whose answer does not matter (it returns void, or a value we do not use).
    func call(_ name: String, _ params: [String: Any] = [:]) async throws {
        let body = try JSONSerialization.data(withJSONObject: params)
        _ = try await send("rest/v1/rpc/\(name)", method: "POST", body: body)
    }

    func select<T: Decodable>(_ table: String, _ query: [URLQueryItem], as type: T.Type = T.self) async throws -> T {
        let (data, _) = try await send("rest/v1/\(table)", query: query)
        return try Self.decodeBody(data)
    }

    private static func decodeBody<T: Decodable>(_ data: Data) throws -> T {
        do {
            return try makeDecoder().decode(T.self, from: data)
        } catch let error as DecodingError {
            let detail = decodingDetail(error)
            // Keep the response body out of logs: message bodies and private conversation data must not be logged.
            FrameLog.event("Supabase decode failed for \(String(describing: T.self)) at \(detail)")
            throw DecodeFailure(detail: detail)
        }
    }

    private struct DecodeFailure: LocalizedError {
        let detail: String
        var errorDescription: String? { "Messages returned an unexpected format (\(detail))." }
    }

    private static func decodingDetail(_ error: DecodingError) -> String {
        let context: DecodingError.Context
        let kind: String
        switch error {
        case .keyNotFound(let key, let value):
            context = value; kind = "missing \(key.stringValue)"
        case .typeMismatch(let type, let value):
            context = value; kind = "expected \(String(describing: type))"
        case .valueNotFound(let type, let value):
            context = value; kind = "missing value for \(String(describing: type))"
        case .dataCorrupted(let value):
            context = value; kind = "invalid value"
        @unknown default:
            return "unknown decode error"
        }
        let path = context.codingPath.map(\.stringValue).joined(separator: ".")
        return path.isEmpty ? kind : "\(path): \(kind)"
    }

    // MARK: Storage

    struct SignedFile: Decodable { let path: String?; let signedURL: String?; let error: String? }

    /// Signed links for a list of files, in one call, keyed by path. Paths that fail are simply absent.
    func signedURLs(_ paths: [String], expiresIn: Int = 3600) async throws -> [String: URL] {
        let unique = Array(Set(paths))
        guard !unique.isEmpty else { return [:] }
        let info = try await NativeSession.shared.validSession()
        let body = try JSONSerialization.data(withJSONObject: ["expiresIn": expiresIn, "paths": unique])
        let (data, _) = try await send("storage/v1/object/sign/\(Self.bucket)", method: "POST", body: body)
        let rows = try JSONDecoder().decode([SignedFile].self, from: data)
        var result: [String: URL] = [:]
        for row in rows {
            guard let path = row.path, let signed = row.signedURL, row.error == nil else { continue }
            // The link is relative to the storage service: "/object/sign/<bucket>/<path>?token=...".
            if let url = URL(string: info.url.absoluteString + "/storage/v1" + signed) { result[path] = url }
        }
        return result
    }

    /// Uploads one file to the private bucket.
    func upload(_ data: Data, path: String, mime: String) async throws {
        let encoded = path.split(separator: "/").map { String($0).addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? String($0) }.joined(separator: "/")
        _ = try await send("storage/v1/object/\(Self.bucket)/\(encoded)", method: "POST", body: data,
                           headers: ["x-upsert": "false", "cache-control": "max-age=3600"], contentType: mime)
    }

    func remove(_ paths: [String]) async {
        guard !paths.isEmpty, let body = try? JSONSerialization.data(withJSONObject: ["prefixes": paths]) else { return }
        _ = try? await send("storage/v1/object/\(Self.bucket)", method: "DELETE", body: body)
    }
}

import QuickLook
import SwiftUI
import UIKit

// MARK: - Details

/// Who is in the conversation, with mute, and block or leave where they apply. For the people who run a channel (an administrator, or whoever
/// made it): its name, description and who may post, the class it follows, who is in it, and archiving. The server checks every one of these
/// again (the web's channel-details.tsx, as a native sheet).
struct ConversationDetailsView: View {
    let conversation: ConversationRow
    @ObservedObject var store: ThreadStore
    @ObservedObject var messages: MessagesStore
    var onClose: () -> Void
    var onLeft: () -> Void

    private struct ClassChoice: Decodable, Identifiable, Hashable { let id: String; let title: String }

    @State private var confirmLeave = false
    @State private var confirmBlock = false
    @State private var confirmArchive = false
    @State private var problem: String?
    @State private var notice: String?
    @State private var busy = false
    @State private var title = ""
    @State private var topic = ""
    @State private var posting = "everyone"
    @State private var classId = ""
    @State private var classes: [ClassChoice] = []
    @State private var addable: [Person] = []
    @State private var adding: Set<String> = []
    @State private var seeded = false

    private var people: [Person] { store.people.values.sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending } }
    private var userId: String { messages.userId }
    private var isAdmin: Bool { messages.roles.contains("admin") }
    private var manager: Bool { conversation.isManaged(by: userId, roles: messages.roles) }
    private var inviteOnly: Bool { conversation.kind == .channel && conversation.audience == "invite" }
    private var candidates: [Person] { addable.filter { person in !people.contains { $0.userId == person.userId } } }

    var body: some View {
        NavigationStack {
            List {
                header
                if manager { detailsSection }
                if isAdmin && conversation.kind == .channel && !conversation.isBuiltIn { classSection }
                if conversation.kind != .direct { membersSection }
                if manager && inviteOnly && !conversation.isArchived { addSection }
                actionsSection
            }
            .scrollContentBackground(.hidden)
            .background(MT.surface)
            .navigationTitle(conversation.isChannel ? "# \(conversation.displayTitle)" : conversation.displayTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done", action: onClose) } }
            .alert("Block \(conversation.displayTitle)?", isPresented: $confirmBlock) {
                Button("Block", role: .destructive) { Task { await run { try await messages.block(conversation.otherUserId ?? ""); onLeft() } } }
                Button("Cancel", role: .cancel) {}
            } message: { Text("They won't be able to message you, and you won't see their messages.") }
            .alert("Leave \(conversation.displayTitle)?", isPresented: $confirmLeave) {
                Button("Leave", role: .destructive) { Task { await run { try await messages.leave(conversation); onLeft() } } }
                Button("Cancel", role: .cancel) {}
            } message: { Text("You will stop receiving its messages.") }
            .alert("Archive this channel?", isPresented: $confirmArchive) {
                Button("Archive", role: .destructive) { Task { await run { try await archive(true); onClose() } } }
                Button("Cancel", role: .cancel) {}
            } message: { Text("It becomes read-only and moves out of the way. Nothing is deleted.") }
        }
        .tint(MT.accentText)
        .presentationDetents([.medium, .large])
        .task { await loadChoices() }
    }

    // MARK: Sections

    private var header: some View {
        Section {
            HStack(spacing: 14) {
                ConversationAvatar(conversation: conversation, size: 64)
                VStack(alignment: .leading, spacing: 2) {
                    if !conversation.flavour.label.isEmpty { Text(conversation.flavour.label.uppercased()).font(.caption2.weight(.bold)).tracking(1).foregroundColor(MT.name(conversation.tone)) }
                    Text(conversation.displayTitle).font(MT.serif(.title3))
                    Text("\(people.count) \(people.count == 1 ? "person" : "people")\(conversation.isArchived ? " · Archived" : "")\(conversation.muted ? " · Muted" : "")")
                        .font(.subheadline).foregroundColor(MT.muted)
                }
            }
            .listRowBackground(MT.surface)
            if let topic = conversation.topic, !topic.isEmpty, !manager { Text(topic).font(.subheadline).listRowBackground(MT.surface) }
            if conversation.isBuiltIn {
                Text("This is a built-in channel. \(conversation.audience == "everyone" ? "Every member is in it automatically." : "")\(conversation.audience == "admins" ? "Only administrators are in it, and they are added and removed automatically. Reports land here; the actual decisions are made on the Messaging tab of the Admin page." : "")")
                    .font(.footnote).foregroundColor(MT.muted).listRowBackground(MT.surface)
            }
            if conversation.kind == .class {
                Text("This channel follows its class. Its members are the class's teachers and the adults of every enrolled child.").font(.footnote).foregroundColor(MT.muted).listRowBackground(MT.surface)
            }
            if conversation.kind == .channel && conversation.audience == "class" {
                Text("This channel follows a class, so its members update as enrollment changes.").font(.footnote).foregroundColor(MT.muted).listRowBackground(MT.surface)
            }
        }
    }

    private var detailsSection: some View {
        Section("Details") {
            if !conversation.isBuiltIn { TextField("Name", text: $title).listRowBackground(MT.surface) }
            TextField("Description", text: $topic, axis: .vertical).lineLimit(1...3).listRowBackground(MT.surface)
            if !conversation.isBuiltIn {
                Picker("Who can post", selection: $posting) {
                    Text("Everyone in the channel").tag("everyone")
                    Text("Only administrators and teachers").tag("staff")
                }
                .listRowBackground(MT.surface)
            }
            Button("Save details") {
                Task { await run { try await SupabaseAPI.shared.call("update_channel", ["p_id": conversation.id, "p_title": title, "p_topic": topic, "p_posting": posting]); notice = "Saved." } }
            }
            .disabled(busy || (!conversation.isBuiltIn && title.trimmingCharacters(in: .whitespaces).isEmpty)).listRowBackground(MT.surface)
            if let notice { Text(notice).font(.footnote).foregroundColor(MT.muted).listRowBackground(MT.surface) }
        }
    }

    private var classSection: some View {
        Section {
            Picker("Class", selection: $classId) {
                Text("Not linked").tag("")
                ForEach(classes) { Text($0.title).tag($0.id) }
            }
            .listRowBackground(MT.surface)
            Button(classId.isEmpty ? "Unlink" : "Link to this class") {
                Task { await run { try await SupabaseAPI.shared.call("set_channel_class", ["p_id": conversation.id, "p_class": classId.isEmpty ? NSNull() : classId as Any]); notice = classId.isEmpty ? "Unlinked. Current members stay." : "Linked to the class." } }
            }
            .disabled(busy || classId == (conversation.classId ?? "")).listRowBackground(MT.surface)
        } header: { Text("Follow a class") } footer: { Text("Linked channels hold the class's teachers and enrolled families, and keep up as enrollment changes.") }
    }

    private var membersSection: some View {
        Section("\(people.count) \(people.count == 1 ? "person" : "people")") {
            ForEach(people) { person in
                HStack(spacing: 12) {
                    AvatarView(label: person.displayName, path: person.avatarPath, tone: MessageTone.toneFor(person.userId), ring: person.ring, size: 34)
                    Text(person.displayName).foregroundColor(MT.text)
                    if person.isTeacher { RoleTag(text: "Teacher", tone: MessageTone.toneFor(person.userId)) }
                    if person.isAdmin { RoleTag(text: "Admin", tone: MessageTone.toneFor(person.userId)) }
                    Spacer(minLength: 0)
                }
                .listRowBackground(MT.surface)
                .swipeActions(edge: .trailing) {
                    if manager && inviteOnly && person.userId != userId {
                        Button(role: .destructive) { Task { await run { try await SupabaseAPI.shared.call("remove_channel_member", ["p_id": conversation.id, "p_user": person.userId]); await store.refreshPeople() } } } label: { Label("Remove", systemImage: "person.badge.minus") }
                    }
                }
            }
        }
    }

    private var addSection: some View {
        Section("Add people") {
            if candidates.isEmpty { Text("No one else you can add.").font(.footnote).foregroundColor(MT.muted).listRowBackground(MT.surface) }
            ForEach(candidates) { person in
                Button {
                    if adding.contains(person.userId) { adding.remove(person.userId) } else { adding.insert(person.userId) }
                } label: {
                    HStack(spacing: 12) {
                        AvatarView(label: person.displayName, path: person.avatarPath, tone: MessageTone.toneFor(person.userId), ring: person.ring, size: 30)
                        Text(person.displayName).foregroundColor(MT.text)
                        Spacer()
                        Image(systemName: adding.contains(person.userId) ? "checkmark.circle.fill" : "circle").foregroundColor(adding.contains(person.userId) ? MT.accentText : MT.muted)
                    }
                }
                .listRowBackground(MT.surface)
            }
            if !adding.isEmpty {
                Button("Add \(adding.count)") {
                    Task { await run { try await SupabaseAPI.shared.call("add_channel_members", ["p_id": conversation.id, "p_members": Array(adding)]); adding = []; await store.refreshPeople() } }
                }
                .disabled(busy).listRowBackground(MT.surface)
            }
        }
    }

    private var actionsSection: some View {
        Section {
            Button { Task { await run { try await messages.setMuted(conversation, !conversation.muted) } } } label: { Label(conversation.muted ? "Unmute" : "Mute", systemImage: conversation.muted ? "bell" : "bell.slash") }
                .listRowBackground(MT.surface)
            if conversation.kind == .direct, conversation.otherUserId != nil {
                Button(role: .destructive) { confirmBlock = true } label: { Label("Block", systemImage: "hand.raised") }.listRowBackground(MT.surface)
            }
            if messages.canLeave(conversation) {
                Button(role: .destructive) { confirmLeave = true } label: { Label(conversation.kind == .group ? "Leave group" : "Leave channel", systemImage: "rectangle.portrait.and.arrow.right") }
                    .listRowBackground(MT.surface)
            }
            if manager && !conversation.isBuiltIn {
                Button { if conversation.isArchived { Task { await run { try await archive(false) } } } else { confirmArchive = true } } label: {
                    Label(conversation.isArchived ? "Restore channel" : "Archive channel", systemImage: conversation.isArchived ? "tray.and.arrow.up" : "archivebox")
                }
                .listRowBackground(MT.surface)
            }
            if let problem { Text(problem).font(.footnote).foregroundColor(MT.dangerText).listRowBackground(MT.surface) }
        }
    }

    // MARK: Actions

    private func archive(_ archived: Bool) async throws {
        try await SupabaseAPI.shared.call("archive_channel", ["p_id": conversation.id, "p_archived": archived])
        notice = archived ? "Archived." : "Restored."
    }

    private func run(_ work: () async throws -> Void) async {
        busy = true; problem = nil
        do {
            try await work()
            await messages.refresh()
            await store.refreshPeople()
            Haptics.play("success")
        } catch { problem = error.localizedDescription; Haptics.play("error") }
        busy = false
    }

    private func loadChoices() async {
        if !seeded {
            seeded = true
            title = conversation.title ?? ""; topic = conversation.topic ?? ""; posting = conversation.posting; classId = conversation.classId ?? ""
        }
        if isAdmin && conversation.kind == .channel && !conversation.isBuiltIn {
            classes = (try? await SupabaseAPI.shared.select("classes", [URLQueryItem(name: "select", value: "id,title"), URLQueryItem(name: "active", value: "eq.true"), URLQueryItem(name: "order", value: "title")])) ?? []
        }
        if manager && inviteOnly && !conversation.isArchived {
            addable = (try? await SupabaseAPI.shared.rpc("messageable_people")) ?? []
            await SignedURLCache.shared.prefetch(addable.compactMap(\.avatarPath))
        }
    }
}

// MARK: - Report, reactions, seen by

struct ReportSheet: View {
    var onSend: (String) async -> Void
    var onCancel: () -> Void
    @State private var reason = ""
    @State private var busy = false
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 14) {
                Text("An administrator will see this message and a few around it. The person who sent it will not be told who reported it.")
                    .font(.subheadline).foregroundColor(MT.muted)
                Text("What is wrong?").font(.footnote.weight(.semibold)).foregroundColor(MT.muted)
                TextField("", text: $reason, axis: .vertical).lineLimit(3...6).focused($focused)
                    .padding(12).background(MT.sunken, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .onChange(of: reason) { if $0.count > 500 { reason = String($0.prefix(500)) } }
                Spacer()
            }
            .padding(18).background(MT.surface.ignoresSafeArea())
            .navigationTitle("Report this message").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: onCancel) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send report") { busy = true; Task { await onSend(reason.trimmingCharacters(in: .whitespacesAndNewlines)); busy = false } }
                        .disabled(reason.trimmingCharacters(in: .whitespaces).isEmpty || busy)
                }
            }
        }
        .tint(MT.accentText)
        .presentationDetents([.medium])
        .onAppear { focused = true }
    }
}

struct ReactionsSheet: View {
    let reactions: [Reaction]
    let people: [String: Person]
    let me: String

    var body: some View {
        NavigationStack {
            List {
                if reactions.isEmpty { Text("No reactions.").foregroundColor(MT.muted).listRowBackground(MT.surface) }
                ForEach(reactionChoices.filter { emoji in reactions.contains { $0.emoji == emoji } }, id: \.self) { emoji in
                    let who = reactions.filter { $0.emoji == emoji }
                    Section {
                        ForEach(who, id: \.userId) { reaction in
                            let person = people[reaction.userId]
                            HStack(spacing: 12) {
                                AvatarView(label: person?.displayName ?? "?", path: person?.avatarPath, tone: MessageTone.toneFor(reaction.userId), ring: person?.ring, size: 32)
                                Text(reaction.userId == me ? "You" : person?.displayName ?? "Former member").foregroundColor(MT.text)
                            }
                            .listRowBackground(MT.surface)
                        }
                    } header: {
                        HStack(spacing: 8) { ReactionIcon(emoji: emoji, size: 26); Text("\(reactionName(emoji)) · \(who.count)").font(.subheadline.weight(.semibold)) }.textCase(nil).foregroundColor(MT.text)
                    }
                }
            }
            .scrollContentBackground(.hidden).background(MT.surface)
            .navigationTitle("Reactions").navigationBarTitleDisplayMode(.inline)
        }
        .tint(MT.accentText)
        .presentationDetents([.medium, .large])
    }
}

struct SeenBySheet: View {
    let load: () async throws -> [SeenPerson]
    @State private var rows: [SeenPerson]?
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            List {
                if let problem { Text(problem).foregroundColor(MT.dangerText).listRowBackground(MT.surface) }
                else if let rows {
                    ForEach([("Seen", rows.filter(\.seen)), ("Not yet", rows.filter { !$0.seen })], id: \.0) { title, group in
                        Section("\(title) (\(group.count))") {
                            if group.isEmpty { Text("No one.").foregroundColor(MT.muted).listRowBackground(MT.surface) }
                            ForEach(group) { person in
                                HStack(spacing: 12) {
                                    AvatarView(label: person.displayName, path: person.avatarPath, tone: MessageTone.toneFor(person.userId), size: 32)
                                    Text(person.displayName).foregroundColor(MT.text)
                                }
                                .listRowBackground(MT.surface)
                            }
                        }
                    }
                    Text("Seen means they opened this conversation after it was posted.").font(.footnote).foregroundColor(MT.muted).listRowBackground(MT.surface)
                } else { HStack { Spacer(); ProgressView(); Spacer() }.listRowBackground(MT.surface) }
            }
            .scrollContentBackground(.hidden).background(MT.surface)
            .navigationTitle("Seen by").navigationBarTitleDisplayMode(.inline)
        }
        .tint(MT.accentText)
        .presentationDetents([.medium, .large])
        .task { do { rows = try await load() } catch { problem = error.localizedDescription } }
    }
}

// MARK: - Photos and files

struct PhotoSet: Identifiable {
    let id = UUID()
    let paths: [String]
    var index: Int
}

/// Photos full size: swipe between them, pinch or double-tap to zoom, share.
struct PhotoViewer: View {
    let set: PhotoSet
    @State private var index: Int
    @Environment(\.dismiss) private var dismiss

    init(set: PhotoSet) { self.set = set; _index = State(initialValue: set.index) }

    var body: some View {
        ZStack(alignment: .top) {
            Color.black.ignoresSafeArea()
            TabView(selection: $index) {
                ForEach(Array(set.paths.enumerated()), id: \.offset) { offset, path in
                    ZoomablePhoto(path: path).tag(offset)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .ignoresSafeArea()
            HStack {
                Button { dismiss() } label: { Image(systemName: "xmark").font(.system(size: 16, weight: .bold)).foregroundColor(.white).frame(width: 40, height: 40).background(.black.opacity(0.45), in: Circle()) }
                    .accessibilityLabel("Close")
                Spacer()
                Text(set.paths.count > 1 ? "Photo \(index + 1) of \(set.paths.count)" : "Photo").font(.subheadline.weight(.semibold)).foregroundColor(.white)
                Spacer()
                if let image = PictureCache.shared.image(for: set.paths[index]) {
                    ShareLink(item: Image(uiImage: image), preview: SharePreview("Photo", image: Image(uiImage: image))) {
                        Image(systemName: "square.and.arrow.up").font(.system(size: 16, weight: .semibold)).foregroundColor(.white).frame(width: 40, height: 40).background(.black.opacity(0.45), in: Circle())
                    }
                } else { Color.clear.frame(width: 40, height: 40) }
            }
            .padding(.horizontal, 16).padding(.top, 8)
        }
        .preferredColorScheme(.dark)
    }
}

private struct ZoomablePhoto: View {
    let path: String
    @State private var scale: CGFloat = 1
    @State private var base: CGFloat = 1

    var body: some View {
        StoredImage(path: path, contentMode: .fit) { ProgressView().tint(.white) }
            .scaleEffect(scale)
            .gesture(MagnificationGesture().onChanged { scale = max(1, base * $0) }.onEnded { _ in base = scale; if scale < 1.05 { scale = 1; base = 1 } })
            .onTapGesture(count: 2) { withAnimation { scale = scale > 1 ? 1 : 2.5; base = scale } }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// A document from a message: downloaded to a temporary file and shown in the system's preview (which can share or save it).
enum FilePreview {
    @MainActor static func open(_ file: Attachment) async {
        guard let url = await SignedURLCache.shared.url(for: file.path),
              let (data, response) = try? await URLSession.shared.data(from: url),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("message-file-\(UUID().uuidString)", isDirectory: true)
        let safe = file.name.components(separatedBy: CharacterSet(charactersIn: "/\\:?*\"<>|")).joined(separator: "-")
        let target = folder.appendingPathComponent(safe.isEmpty ? "file" : safe)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try data.write(to: target)
        } catch { return }
        let controller = QLPreviewController()
        let source = PreviewSource(url: target)
        controller.dataSource = source
        objc_setAssociatedObject(controller, &PreviewSource.key, source, .OBJC_ASSOCIATION_RETAIN)
        NativeMessages.shared.topPresenter?.present(controller, animated: true)
    }

    private final class PreviewSource: NSObject, QLPreviewControllerDataSource {
        static var key = 0
        let url: URL
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { url as NSURL }
    }
}

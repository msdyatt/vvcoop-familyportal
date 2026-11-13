import QuickLook
import SwiftUI
import UIKit

// MARK: - Details

/// Who is in the conversation, with mute, and block or leave where they apply. (Editing a channel's name, rules and members is the
/// next step; the server checks every one of these again.)
struct ConversationDetailsView: View {
    let conversation: ConversationRow
    @ObservedObject var store: ThreadStore
    @ObservedObject var messages: MessagesStore
    var onClose: () -> Void
    var onLeft: () -> Void

    @State private var confirmLeave = false
    @State private var confirmBlock = false
    @State private var problem: String?

    private var people: [Person] { store.people.values.sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending } }

    var body: some View {
        NavigationStack {
            List {
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
                    if let topic = conversation.topic, !topic.isEmpty { Text(topic).font(.subheadline).listRowBackground(MT.surface) }
                    if conversation.isBuiltIn {
                        Text("This is a built-in channel. \(conversation.audience == "everyone" ? "Every member is in it automatically." : "")\(conversation.audience == "admins" ? "Only administrators are in it, and they are added and removed automatically." : "")")
                            .font(.footnote).foregroundColor(MT.muted).listRowBackground(MT.surface)
                    }
                    if conversation.kind == .class {
                        Text("This channel follows its class. Its members are the class's teachers and the adults of every enrolled child.").font(.footnote).foregroundColor(MT.muted).listRowBackground(MT.surface)
                    }
                }
                if conversation.kind != .direct { Section("\(people.count) \(people.count == 1 ? "person" : "people")") {
                    ForEach(people) { person in
                        HStack(spacing: 12) {
                            AvatarView(label: person.displayName, path: person.avatarPath, tone: MessageTone.toneFor(person.userId), ring: person.ring, size: 34)
                            Text(person.displayName).foregroundColor(MT.text)
                            if person.isTeacher { RoleTag(text: "Teacher", tone: MessageTone.toneFor(person.userId)) }
                            if person.isAdmin { RoleTag(text: "Admin", tone: MessageTone.toneFor(person.userId)) }
                        }
                        .listRowBackground(MT.surface)
                    }
                } }
                Section {
                    Button { Task { await mute() } } label: { Label(conversation.muted ? "Unmute" : "Mute", systemImage: conversation.muted ? "bell" : "bell.slash") }
                        .listRowBackground(MT.surface)
                    if conversation.kind == .direct, conversation.otherUserId != nil {
                        Button(role: .destructive) { confirmBlock = true } label: { Label("Block", systemImage: "hand.raised") }.listRowBackground(MT.surface)
                    }
                    if messages.canLeave(conversation) {
                        Button(role: .destructive) { confirmLeave = true } label: { Label(conversation.kind == .group ? "Leave group" : "Leave channel", systemImage: "rectangle.portrait.and.arrow.right") }
                            .listRowBackground(MT.surface)
                    }
                    if let problem { Text(problem).font(.footnote).foregroundColor(MT.dangerText).listRowBackground(MT.surface) }
                }
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
        }
        .tint(MT.accentText)
        .presentationDetents([.medium, .large])
    }

    private func mute() async { await run { try await messages.setMuted(conversation, !conversation.muted) } }

    private func run(_ work: () async throws -> Void) async {
        do { try await work(); Haptics.play("success") } catch { problem = error.localizedDescription; Haptics.play("error") }
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
                    } header: { Text("\(emoji)  \(who.count)").font(.title3).textCase(nil) }
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

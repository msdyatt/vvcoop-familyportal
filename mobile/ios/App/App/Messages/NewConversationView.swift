import SwiftUI

/// Start a conversation: one person, a group, a channel or a class channel (the web's "New message" sheet,
/// app/family-village/messages/new-conversation.tsx). The server checks every one of these again.
struct NewConversationView: View {
    @ObservedObject var store: MessagesStore
    var onOpen: (String) -> Void
    var onClose: () -> Void

    private enum Tab: String, CaseIterable, Identifiable {
        case direct = "One person", group = "New group", channel = "New channel", `class` = "Class channel"
        var id: String { rawValue }
    }
    private struct ClassChoice: Decodable, Identifiable, Hashable { let id: String; let title: String }
    private struct AssignmentRow: Decodable { let classes: ClassChoice? }

    @State private var tab: Tab = .direct
    @State private var people: [Person] = []
    @State private var classes: [ClassChoice] = []
    @State private var search = ""
    @State private var chosen: Set<String> = []
    @State private var name = ""
    @State private var topic = ""
    @State private var posting = "everyone"
    @State private var audience = "invite"
    @State private var channelClass = ""
    @State private var busy = false
    @State private var loaded = false
    @State private var problem: String?

    private var canLead: Bool { store.roles.contains("teacher") || store.roles.contains("admin") }
    private var isAdmin: Bool { store.roles.contains("admin") }
    private var tabs: [Tab] {
        var list: [Tab] = [.direct]
        if canLead { list.append(.group) }
        if store.canCreateChannel { list.append(.channel) }
        if canLead { list.append(.class) }
        return list
    }
    private var pickingPeople: Bool { tab == .direct || tab == .group || (tab == .channel && audience == "invite" && channelClass.isEmpty) }
    private var shown: [Person] {
        let needle = search.trimmingCharacters(in: .whitespaces).lowercased()
        return people.filter { needle.isEmpty || $0.displayName.lowercased().contains(needle) }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if tabs.count > 1 {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 6) {
                                ForEach(tabs) { item in
                                    Button { tab = item; problem = nil } label: {
                                        Text(item.rawValue).font(.subheadline.weight(.semibold)).padding(.horizontal, 14).padding(.vertical, 8)
                                            .foregroundColor(tab == item ? Color(MT.cream) : MT.text)
                                            .background(tab == item ? MT.action : MT.sunken, in: Capsule())
                                    }
                                    .accessibilityAddTraits(tab == item ? .isSelected : [])
                                }
                            }
                        }
                    }

                    if tab == .group { field("Group name", text: $name, prompt: "Field trip drivers") }
                    if tab == .channel { channelFields }
                    if tab == .class { classList }

                    if pickingPeople {
                        field(tab == .channel ? "Invite people" : "Find someone", text: $search, prompt: "Search by name", autoFocus: false)
                        peopleList
                    }

                    if let problem { Text(problem).font(.footnote).foregroundColor(MT.dangerText) }
                    if tab == .group { createButton("Create group\(chosen.isEmpty ? "" : " (\(chosen.count))")", disabled: name.trimmingCharacters(in: .whitespaces).isEmpty || chosen.isEmpty, create: createGroup) }
                    if tab == .channel { createButton("Create channel", disabled: name.trimmingCharacters(in: .whitespaces).isEmpty, create: createChannel) }
                }
                .padding(18)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(MT.surface.ignoresSafeArea())
            .navigationTitle(tab == .channel ? "New channel" : "New message")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: onClose) } }
        }
        .tint(MT.accentText)
        .task(id: store.roles.joined(separator: ",")) { await load() }
    }

    // MARK: Pieces

    private func field(_ caption: String, text: Binding<String>, prompt: String, autoFocus: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(caption).font(.footnote.weight(.semibold)).foregroundColor(MT.muted)
            TextField(prompt, text: text).textInputAutocapitalization(.sentences).autocorrectionDisabled(caption.hasPrefix("Find") || caption.hasPrefix("Invite"))
                .padding(.horizontal, 14).padding(.vertical, 11).background(MT.sunken, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
    }

    private var channelFields: some View {
        VStack(alignment: .leading, spacing: 14) {
            field("Channel name", text: $name, prompt: "Carpool")
            field("Description (optional)", text: $topic, prompt: "")
            menuRow("Who can post", selection: $posting, options: [("everyone", "Everyone in the channel"), ("staff", "Only administrators and teachers")])
            if isAdmin {
                menuRow("Who is in it", selection: $audience, options: [("invite", "People I choose below"), ("everyone", "Everyone in the co-op")]).disabled(!channelClass.isEmpty)
            }
            if !classes.isEmpty {
                menuRow("Follow a class (optional)", selection: $channelClass, options: [("", "No, not tied to a class")] + classes.map { ($0.id, $0.title) })
            }
        }
    }

    private func menuRow(_ caption: String, selection: Binding<String>, options: [(String, String)]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(caption).font(.footnote.weight(.semibold)).foregroundColor(MT.muted)
            Menu {
                Picker(caption, selection: selection) { ForEach(options, id: \.0) { Text($0.1).tag($0.0) } }
            } label: {
                HStack {
                    Text(options.first { $0.0 == selection.wrappedValue }?.1 ?? "").foregroundColor(MT.text).lineLimit(1)
                    Spacer()
                    Image(systemName: "chevron.up.chevron.down").font(.footnote).foregroundColor(MT.muted)
                }
                .padding(.horizontal, 14).padding(.vertical, 11).background(MT.sunken, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
        }
    }

    private var classList: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("A class channel holds the class's teachers and the adults of every enrolled child. It updates itself as enrollment changes.")
                .font(.subheadline).foregroundColor(MT.muted).padding(.bottom, 6)
            ForEach(classes) { row in
                Button { open { try await SupabaseAPI.shared.rpc("open_class_conversation", ["p_class_id": row.id]) } } label: {
                    HStack { Text(row.title).foregroundColor(MT.text); Spacer(); Image(systemName: "chevron.right").font(.footnote).foregroundColor(MT.muted) }
                        .padding(.vertical, 12).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(busy)
                Divider()
            }
            if loaded && classes.isEmpty { Text("No classes to open.").font(.subheadline).foregroundColor(MT.muted) }
        }
    }

    private var peopleList: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(shown) { person in
                Button { tapPerson(person) } label: {
                    HStack(spacing: 12) {
                        AvatarView(label: person.displayName, path: person.avatarPath, tone: MessageTone.toneFor(person.userId), ring: person.ring, size: 36)
                        Text(person.displayName).foregroundColor(MT.text).lineLimit(1)
                        if let role = roleLabel(person) {
                            Text(role.uppercased()).font(.system(size: 9.5, weight: .bold)).tracking(0.8).foregroundColor(MT.name(MessageTone.toneFor(person.userId)))
                                .padding(.horizontal, 7).padding(.vertical, 1.5).background(MT.wash(MessageTone.toneFor(person.userId)), in: Capsule())
                        }
                        Spacer()
                        if tab != .direct { Image(systemName: chosen.contains(person.userId) ? "checkmark.circle.fill" : "circle").font(.title3).foregroundColor(chosen.contains(person.userId) ? MT.accentText : MT.muted) }
                    }
                    .padding(.vertical, 8).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(busy)
                .accessibilityAddTraits(chosen.contains(person.userId) ? .isSelected : [])
                Divider()
            }
            if loaded && shown.isEmpty {
                Text(people.isEmpty ? "There is no one you can message yet." : "No one matches that search.").font(.subheadline).foregroundColor(MT.muted).padding(.top, 8)
            }
            if !loaded { ProgressView().frame(maxWidth: .infinity).padding(.top, 20) }
        }
    }

    private func roleLabel(_ person: Person) -> String? { person.isAdmin ? "Administrator" : person.isTeacher ? "Teacher" : nil }

    private func createButton(_ title: String, disabled: Bool, create: @escaping () -> Void) -> some View {
        Button(action: create) {
            Text(busy ? "Creating…" : title).font(.body.weight(.semibold)).frame(maxWidth: .infinity).padding(.vertical, 13)
                .foregroundColor(Color(MT.cream)).background(MT.action.opacity(disabled || busy ? 0.4 : 1), in: Capsule())
        }
        .disabled(disabled || busy)
    }

    // MARK: Actions

    private func tapPerson(_ person: Person) {
        Haptics.play("selection")
        if tab == .direct {
            open { try await SupabaseAPI.shared.rpc("start_direct_conversation", ["p_other": person.userId]) }
        } else if chosen.contains(person.userId) { chosen.remove(person.userId) } else { chosen.insert(person.userId) }
    }

    private func createGroup() {
        open { try await SupabaseAPI.shared.rpc("create_group_conversation", ["p_title": name, "p_members": Array(chosen)]) }
    }

    private func createChannel() {
        let members: [String] = audience == "invite" && channelClass.isEmpty ? Array(chosen) : []
        open {
            try await SupabaseAPI.shared.rpc("create_channel", [
                "p_title": name, "p_topic": topic.isEmpty ? NSNull() : topic as Any, "p_posting": posting,
                "p_audience": channelClass.isEmpty ? audience : "invite", "p_class": channelClass.isEmpty ? NSNull() : channelClass as Any,
                "p_members": members,
            ])
        }
    }

    /// Runs a call that answers with the conversation's id, then opens it.
    private func open(_ work: @escaping () async throws -> String) {
        busy = true; problem = nil
        Task {
            do {
                let id = try await work()
                Haptics.play("success")
                await store.refresh()
                busy = false
                onOpen(id)
            } catch {
                busy = false
                problem = error.localizedDescription
                Haptics.play("error")
            }
        }
    }

    private func load() async {
        if let rows: [Person] = try? await SupabaseAPI.shared.rpc("messageable_people") {
            people = rows
            await SignedURLCache.shared.prefetch(rows.compactMap(\.avatarPath))
        }
        if canLead {
            if isAdmin {
                classes = (try? await SupabaseAPI.shared.select("classes", [URLQueryItem(name: "select", value: "id,title"), URLQueryItem(name: "active", value: "eq.true"), URLQueryItem(name: "order", value: "title")])) ?? []
            } else {
                let rows: [AssignmentRow] = (try? await SupabaseAPI.shared.select("teacher_assignments", [URLQueryItem(name: "select", value: "classes(id,title)"), URLQueryItem(name: "user_id", value: "eq.\(store.userId)")])) ?? []
                classes = rows.compactMap(\.classes)
            }
        }
        loaded = true
    }
}

import UIKit

/// The Menu tab's sheet: the sections and destinations the person can reach, then the account actions.
/// Destinations come from the page (so the list has one definition, in lib/nav-prefs.ts); the four
/// actions run the web screens that already exist.
final class MenuController: UITableViewController {
    enum Action: String {
        case customize, account, tour, signOut
    }

    private enum Row {
        case destination(FrameDestination)
        case action(Action, String, String)
        case lockSwitch
    }

    private var groups: [(title: String?, rows: [Row])] = []
    var onDestination: ((FrameDestination) -> Void)?
    var onAction: ((Action) -> Void)?

    init(state: FrameState) {
        super.init(style: .insetGrouped)
        title = "Menu"
        var built: [(String?, [Row])] = []
        built.append((nil, [.destination(FrameDestination(id: "home-page", label: "Home", href: state.home, icon: "home"))]))
        for group in state.menu {
            let rows = group.items.filter { $0.id != "home" }.map { Row.destination($0) }
            // Family and Teaching items are one untitled list; only Admin has a heading.
            if !rows.isEmpty { built.append((group.title.isEmpty ? nil : group.title, rows)) }
        }
        built.append((nil, [
            .action(.customize, "Customize bottom bar", "slider.horizontal.3"),
            .action(.account, "Account & security", "person.crop.circle"),
            .action(.tour, "Take the tour", "questionmark.circle"),
        ]))
        if AppLock.shared.canLock { built.append(("Privacy", [.lockSwitch])) }
        built.append((nil, [.action(.signOut, "Sign out", "rectangle.portrait.and.arrow.right")]))
        groups = built
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        tableView.backgroundColor = Brand.canvas
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "row")
        navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .done, primaryAction: UIAction { [weak self] _ in
            self?.dismiss(animated: true)
        })
    }

    override func numberOfSections(in tableView: UITableView) -> Int { groups.count }
    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { groups[section].rows.count }
    override func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? { groups[section].title }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "row", for: indexPath)
        var content = cell.defaultContentConfiguration()
        switch groups[indexPath.section].rows[indexPath.row] {
        case .destination(let destination):
            content.text = destination.label
            content.image = Symbols.image(for: destination.icon)
            cell.accessoryType = .disclosureIndicator
        case .lockSwitch:
            content.text = "Lock with Face ID"
            content.secondaryText = "Ask when you come back to the app"
            content.image = UIImage(systemName: "faceid")
            let toggle = UISwitch()
            toggle.isOn = AppLock.shared.isEnabled
            toggle.onTintColor = Brand.action
            toggle.addAction(UIAction { [weak toggle] _ in AppLock.shared.isEnabled = toggle?.isOn ?? true }, for: .valueChanged)
            cell.accessoryView = toggle
        case .action(let action, let text, let symbol):
            content.text = text
            content.image = UIImage(systemName: symbol)
            if action == .signOut { content.textProperties.color = .systemRed; content.imageProperties.tintColor = .systemRed }
            cell.accessoryType = .none
        }
        if case .lockSwitch = groups[indexPath.section].rows[indexPath.row] {} else { cell.accessoryView = nil }
        if content.imageProperties.tintColor == nil { content.imageProperties.tintColor = Brand.ink }
        cell.contentConfiguration = content
        cell.backgroundColor = Brand.surface
        return cell
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        let row = groups[indexPath.section].rows[indexPath.row]
        if case .lockSwitch = row { return }
        dismiss(animated: true) { [weak self] in
            switch row {
            case .lockSwitch: break
            case .destination(let destination): self?.onDestination?(destination)
            case .action(let action, _, _): self?.onAction?(action)
            }
        }
    }
}

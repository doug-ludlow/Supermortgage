import SwiftUI

// The vocabulary of the shell. Everything here mirrors the prototype's `A` state, `WORK`, `ARTS`,
// `MEDIA`, the chat thread and the feed. Values only; behavior lives in AppModel and ChatEngine.

enum Stage: Equatable {
    case welcome, know, setup, chat
}

enum ShellTab: String, CaseIterable, Identifiable {
    case chat = "Chat"
    case feed = "Feed"
    case work = "Work"
    case goals = "Goals"
    case artifacts = "Artifacts"

    var id: String { rawValue }
    var label: String { rawValue }
}

enum WorkCategory: String, CaseIterable, Identifiable {
    case upgrade = "Upgrade"
    case income = "Income"
    case eliminate = "Eliminate"

    var id: String { rawValue }
    var label: String { rawValue }
}

enum WorkStatus: CaseIterable, Equatable {
    case running, needsYou, done, waiting, needsConnection, doesntApply

    /// `STATUS` in the prototype.
    var label: String {
        switch self {
        case .running: return "Running"
        case .needsYou: return "Needs you"
        case .done: return "Done"
        case .waiting: return "Waiting"
        case .needsConnection: return "Needs a connection"
        case .doesntApply: return "Doesn’t apply"
        }
    }
}

enum WorkKey: String, Equatable {
    case refi, lock, buffer, site, grid, pmi, smud, util
}

enum ArtifactID: String, CaseIterable, Hashable {
    case dash, refi, audit, pmi, ins, site, tax
}

/// One row of `WORK_RAW`: category, title, detail, cadence, status, dollars/mo, meta, extra.
struct WorkRow {
    let category: WorkCategory
    let title: String
    let detail: String
    let cadence: String
    let status: WorkStatus
    let dollars: Double
    let meta: String
    let key: WorkKey?
    let artifact: ArtifactID?
    let once: Double?
}

struct WorkItem: Identifiable, Equatable {
    let id: String
    let category: WorkCategory
    let title: String
    let detail: String
    let cadence: String
    var status: WorkStatus
    let dollarsPerMonth: Double
    let once: Double?
    var meta: String
    let key: WorkKey?
    let artifactId: ArtifactID?
    var askFirst: Bool
    var paused: Bool

    init(id: String, row: WorkRow) {
        self.id = id
        category = row.category
        title = row.title
        detail = row.detail
        cadence = row.cadence
        status = row.status
        dollarsPerMonth = row.dollars
        once = row.once
        meta = row.meta
        key = row.key
        artifactId = row.artifact
        askFirst = row.status == .needsYou || WorkItem.asksFirstByTitle(row.title)
        paused = false
    }

    /// The prototype's rule: `['need'].includes(status) || /lock|policy|sign|refinance|debt/i.test(title)`.
    static func asksFirstByTitle(_ title: String) -> Bool {
        title.range(of: "lock|policy|sign|refinance|debt", options: [.regularExpression, .caseInsensitive]) != nil
    }

    /// The rows the "No tenants" goal retires: `/room|ADU|rent the house|sublet/i`.
    static func isTenantRow(_ title: String) -> Bool {
        title.range(of: "room|ADU|rent the house|sublet", options: [.regularExpression, .caseInsensitive]) != nil
    }

    /// The chip label: "Paused" replaces the status while paused.
    var statusLabel: String { paused ? "Paused" : status.label }
}

struct Artifact: Identifiable, Equatable {
    let id: ArtifactID
    let title: String
    var subtitle: String
    let live: Bool
}

enum MediaKind: Equatable {
    case file, camera
}

struct MediaItem: Identifiable, Equatable {
    let id: UUID
    let title: String
    let kind: MediaKind

    init(title: String, kind: MediaKind) {
        id = UUID()
        self.title = title
        self.kind = kind
    }
}

// MARK: - Chat

enum MessageRole: Equatable {
    case agent, user
}

struct KeyValue: Identifiable, Equatable {
    let key: String
    let value: String
    var id: String { key }
}

/// A run of text inside a rich message; `bold` reproduces the prototype's `<strong>`.
struct Span: Equatable {
    let text: String
    let bold: Bool

    static func plain(_ text: String) -> Span { Span(text: text, bold: false) }
    static func bold(_ text: String) -> Span { Span(text: text, bold: true) }
}

struct ProgressState: Equatable {
    var loading: String
    var done: String?
    var small: String?

    var isDone: Bool { done != nil }
}

enum MessageBody: Equatable {
    case typing
    case text(String)
    case bullets(lead: String, items: [[Span]])
    case number(lead: String, amount: String?, rows: [KeyValue])
    case progress(ProgressState)
}

enum ChatAction: Equatable {
    case nameMe(String)
    case nameOther
    case connMortgage(String)
    case connCredit(String)
    case plaid
    case reviewPMI
    case startRefi
    case showArtifact(ArtifactID)
    case notYet
    case schedule
    case doNow(String)
}

struct ChatOption: Identifiable, Equatable {
    let label: String
    let action: ChatAction
    let primary: Bool

    init(_ label: String, _ action: ChatAction, primary: Bool = false) {
        self.label = label
        self.action = action
        self.primary = primary
    }

    var id: String { label }
}

struct Message: Identifiable, Equatable {
    let id: UUID
    var role: MessageRole
    var body: MessageBody
    var options: [ChatOption]?
    var used: Bool

    /// Options are shown only while no option in the thread has been used (`m.options && !m.used`).
    var visibleOptions: [ChatOption] {
        guard let options, !used else { return [] }
        return options
    }
}

// MARK: - Feed, log, goals

enum PostAction: Equatable {
    case reviewPMI, startRefi
}

struct Post: Identifiable, Equatable {
    let id: String
    let icon: String
    var title: String
    var body: String
    let at: String
    var tag: String?
    var action: PostAction?
}

struct LogEntry: Identifiable, Equatable {
    let id: UUID
    let text: String
    let at: String

    init(text: String, at: String) {
        id = UUID()
        self.text = text
        self.at = at
    }
}

struct Goal: Identifiable, Equatable {
    let id: UUID
    let title: String
    let note: String

    init(title: String, note: String) {
        id = UUID()
        self.title = title
        self.note = note
    }
}

/// The six "Create a goal" rows with their icons.
struct GoalCategory: Identifiable, Equatable {
    let title: String
    let icon: IconName
    var id: String { title }

    static let all: [GoalCategory] = [
        GoalCategory(title: "Pay off by a date", icon: .calendar),
        GoalCategory(title: "Add an ADU", icon: .home),
        GoalCategory(title: "Move in a few years", icon: .arrow),
        GoalCategory(title: "Keep my escrow", icon: .lock),
        GoalCategory(title: "No tenants", icon: .user),
        GoalCategory(title: "Something else", icon: .target),
    ]

    /// The goal sheet's per-category placeholder.
    var placeholder: String {
        switch title {
        case "Pay off by a date": return "e.g. paid off before I retire in 2038"
        case "No tenants": return "e.g. no one living on the property, ever"
        default: return "Anything you want me to plan around"
        }
    }
}

// MARK: - State enums

enum PMIState: Equatable {
    case ready, requested
}

enum RefiState: Equatable {
    case offered, started, declined
}

enum EscrowRefundState: String, Equatable {
    case requested, approved
}

struct Connections: Equatable {
    var mortgage = false
    var credit = false
    var plaid = false
}

enum ApprovalsSetting: String, CaseIterable, Identifiable {
    case everything = "all"
    case binding = "binding"
    case justDoIt = "none"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .everything: return "Ask me about everything"
        case .binding: return "Ask before anything binding"
        case .justDoIt: return "Just do it"
        }
    }

    var detail: String {
        switch self {
        case .everything: return "Every action gets a card"
        case .binding: return "Reads, quotes and filings run on their own; locks, cancellations and signatures ask"
        case .justDoIt: return "Only signatures ask"
        }
    }
}

enum NotifySetting: String, CaseIterable, Identifiable {
    case moves, daily, all

    var id: String { rawValue }

    var title: String {
        switch self {
        case .moves: return "Only when my number moves or you need a yes"
        case .daily: return "A daily brief"
        case .all: return "Everything you do"
        }
    }
}

enum AppTheme: String, CaseIterable, Identifiable {
    case light, dark

    var id: String { rawValue }
    var label: String { self == .light ? "Light" : "Dark" }
    var colorScheme: ColorScheme { self == .dark ? .dark : .light }
}

enum ArtifactsSegment: String, CaseIterable, Identifiable {
    case artifacts = "Artifacts"
    case media = "Media"

    var id: String { rawValue }
    var label: String { rawValue }
}

enum AgentSegment: String, CaseIterable, Identifiable {
    case activity = "Activity"
    case permissions = "Permissions"
    case memory = "Memory"

    var id: String { rawValue }
    var label: String { rawValue }
}

/// The Menu sheet's side chats: the user bubble and the `answer()` query each one runs.
enum SideChat: String, CaseIterable, Identifiable {
    case refi, pmi, ins

    var id: String { rawValue }

    var title: String {
        switch self {
        case .refi: return "The refinance"
        case .pmi: return "PMI cancellation"
        case .ins: return "Insurance renewal"
        }
    }

    var userText: String {
        switch self {
        case .refi: return "The refinance"
        case .pmi: return "PMI"
        case .ins: return "Insurance"
        }
    }

    var query: String {
        switch self {
        case .refi: return "refi"
        case .pmi: return "pmi"
        case .ins: return "insurance"
        }
    }
}

/// The keys `connect(k)` accepts: from a Work sheet (grid · smud · util) or Settings (ins · smud).
enum ConnectKey: String, Equatable {
    case smud, util, grid, ins

    init?(workKey: WorkKey?) {
        switch workKey {
        case .smud: self = .smud
        case .util: self = .util
        case .grid: self = .grid
        default: return nil
        }
    }
}

/// Every sheet the shell can show. One at a time; presenting another replaces it.
enum SheetKind: Identifiable, Equatable {
    case menu
    case agent(AgentSegment)
    case invite
    case attach
    case name
    case plaid
    case approval
    case work(String)
    case artifact(ArtifactID)
    case whyPost(String)
    case editInstructions
    case newGoal(String)
    case goalOpen(String)
    case settings
    case about
    case schedule

    var id: String {
        switch self {
        case .menu: return "menu"
        case .agent(let seg): return "agent-\(seg.rawValue)"
        case .invite: return "invite"
        case .attach: return "attach"
        case .name: return "name"
        case .plaid: return "plaid"
        case .approval: return "approval"
        case .work(let id): return "work-\(id)"
        case .artifact(let id): return "artifact-\(id.rawValue)"
        case .whyPost(let id): return "why-\(id)"
        case .editInstructions: return "instructions"
        case .newGoal(let title): return "goal-\(title)"
        case .goalOpen(let title): return "goal-open-\(title)"
        case .settings: return "settings"
        case .about: return "about"
        case .schedule: return "schedule"
        }
    }
}

import SwiftUI

/// Chooses the onboarding screen or the shell by `stage`, applies the in-app Appearance,
/// and hosts the one sheet, the Refinance cover and the toast.
struct RootView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        RootContent()
            .resolvedTokens()
            .preferredColorScheme(model.theme.colorScheme)
    }
}

private struct RootContent: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var router: Router
    @Environment(\.tokens) private var t
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            t.paper.ignoresSafeArea()
            switch model.stage {
            case .welcome:
                WelcomeView()
            case .know:
                HowIWorkView()
            case .setup:
                SetupView()
            case .chat:
                ShellView()
            }
        }
        .overlay(alignment: .bottom) {
            if let text = router.toastText {
                Toast(text: text)
                    .padding(.bottom, 152)
                    .transition(reduceMotion ? .identity : .opacity.combined(with: .offset(y: 8)))
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.18), value: router.toastText)
        .sheet(item: $router.sheet) { kind in
            SheetHost(kind: kind)
                .environmentObject(model)
                .environmentObject(router)
        }
        .fullScreenCover(isPresented: $router.refinanceShown, onDismiss: { model.closeRefinance() }) {
            RefinanceCover()
                .environmentObject(model)
                .environmentObject(router)
        }
    }
}

/// Maps a `SheetKind` to its view and applies the sheet presentation.
struct SheetHost: View {
    let kind: SheetKind

    @EnvironmentObject private var model: AppModel
    @State private var detent: PresentationDetent

    init(kind: SheetKind) {
        self.kind = kind
        _detent = State(initialValue: kind.opensLarge ? .large : .medium)
    }

    var body: some View {
        SheetBody(kind: kind)
            .resolvedTokens()
            .preferredColorScheme(model.theme.colorScheme)
            .presentationDetents([.medium, .large], selection: $detent)
            .presentationDragIndicator(.hidden)
            .presentationCornerRadius(30)
            .presentationBackground(model.theme == .dark ? Tokens.dark.paper : Tokens.light.paper)
    }
}

private struct SheetBody: View {
    let kind: SheetKind

    var body: some View {
        switch kind {
        case .menu: MenuSheet()
        case .agent(let segment): AgentSheet(initialSegment: segment)
        case .invite: InviteSheet()
        case .attach: AttachSheet()
        case .name: NameSheet()
        case .plaid: PlaidSheet()
        case .approval: ApprovalSheet()
        case .work(let id): WorkSheet(id: id)
        case .artifact(let id): ArtifactSheet(id: id)
        case .whyPost(let id): WhyPostSheet(postId: id)
        case .editInstructions: InstructionsSheet()
        case .newGoal(let title): GoalSheet(title: title)
        case .goalOpen(let title): GoalOpenSheet(title: title)
        case .settings: SettingsSheet()
        case .about: AboutSheet()
        case .schedule: ScheduleSheet()
        }
    }
}

extension SheetKind {
    /// Content-heavy sheets open at the large detent so nothing hides below the fold.
    var opensLarge: Bool {
        switch self {
        case .menu, .agent, .approval, .work, .artifact, .settings, .about, .plaid:
            return true
        default:
            return false
        }
    }
}

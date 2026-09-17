import SwiftUI

/// The shell: the current tab's screen under a sticky `HeaderBar`, over the fixed footer
/// (composer on Chat, then the tab bar) on a `paper` fade.
struct ShellView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Group {
            switch model.tab {
            case .chat: ChatView()
            case .feed: FeedView()
            case .work: WorkView()
            case .goals: GoalsView()
            case .artifacts: ArtifactsView()
            }
        }
        .id(model.tab)
        .safeAreaInset(edge: .top, spacing: 0) {
            HeaderBar()
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            FooterBar()
        }
    }
}

/// `.ag-footer`: composer (Chat only) and tab bar, 14pt above, 20pt below the safe area.
struct FooterBar: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.tokens) private var t

    var body: some View {
        VStack(spacing: 10) {
            if model.tab == .chat {
                Composer()
            }
            TabBar()
        }
        .padding(.top, 14)
        .padding(.horizontal, 16)
        .padding(.bottom, 20)
        .background {
            LinearGradient(stops: [
                .init(color: t.paperFade.opacity(0), location: 0),
                .init(color: t.paperFade, location: 0.55),
                .init(color: t.paperFade, location: 1),
            ], startPoint: .top, endPoint: .bottom)
            .ignoresSafeArea(edges: .bottom)
        }
    }
}

/// `.ag-screen > h1`: the tab heading — 24/29 semibold, 12pt above, 18pt below.
struct ScreenTitle: View {
    let text: String

    @Environment(\.tokens) private var t

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .textStyle(.title)
            .foregroundStyle(t.text)
            .padding(.top, 12)
            .padding(.bottom, 18)
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("screen.title")
    }
}

/// The scrolling page for a non-Chat tab: `#ag-view` padding (4pt top, 16pt gutters), scrolled to the top.
struct TabPage<Content: View>: View {
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                content
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 4)
            .padding(.horizontal, 16)
            .padding(.bottom, 15)
            .screenEnter()
        }
    }
}

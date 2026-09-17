import SwiftUI

/// Menu — Side chats, then More.
struct MenuSheet: View {
    @EnvironmentObject private var model: AppModel

    private func subtitle(_ chat: SideChat) -> String {
        switch chat {
        case .refi: return "5.75% offered · ready to start"
        case .pmi: return model.pmi == .requested ? "Sent · servicer has 30 days" : "Needs your yes"
        case .ins: return "Quotes Feb 1 · renews Mar 3"
        }
    }

    var body: some View {
        SheetContainer("Menu") {
            SectionHeading("Side chats", top: 0)
            ForEach(SideChat.allCases) { chat in
                MenuRow(icon: .chat, title: chat.title, small: subtitle(chat)) { model.sideChat(chat) }
            }
            SectionHeading("More")
            MenuRow(icon: .sliders, title: "Settings", small: "Connections, approvals, notifications") { model.openSettings() }
            MenuRow(icon: .edit, title: "What I know about your home", small: "Read and edit my memory") { model.openAgent(.memory) }
            MenuRow(icon: .user, title: "Invite a neighbor", small: "Better prices when the street buys together") { model.openInvite() }
            MenuRow(icon: .info, title: "About Supermortgage", small: "What it is and how it makes money") { model.openAbout() }
        }
    }
}

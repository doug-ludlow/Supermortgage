import SwiftUI

/// "Invite a neighbor" — the paragraph, the read-only link, "Copy link".
struct InviteSheet: View {
    /// Set when the Refinance cover hosts this sheet itself.
    var onClose: (() -> Void)? = nil

    @EnvironmentObject private var model: AppModel
    @Environment(\.tokens) private var t

    var body: some View {
        SheetContainer("Invite a neighbor", onClose: onClose) {
            IntroText(Copy.inviteIntro, color: t.muted)
            ReadOnlyField(label: "Your link", value: Copy.inviteLink)
            ActionStack {
                PrimaryButton("Copy link") { model.copyInviteLink() }
            }
        }
    }
}

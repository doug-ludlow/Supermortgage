import SwiftUI

/// "Why this post" — the feed instructions and when the post met the bar.
struct WhyPostSheet: View {
    let postId: String

    @EnvironmentObject private var model: AppModel
    @Environment(\.tokens) private var t

    var body: some View {
        SheetContainer("Why this post") {
            IntroText("Your feed instructions: “\(model.feedInstructions)”", color: t.muted)
            IntroText("\(Copy.whyPostBar) Posted \(model.post(id: postId)?.at ?? "").", color: t.muted)
        }
    }
}

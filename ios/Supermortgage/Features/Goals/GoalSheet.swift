import SwiftUI

/// A "Create a goal" sheet: the intro, a text area with the category's placeholder, "Build the plan".
struct GoalSheet: View {
    let title: String

    @EnvironmentObject private var model: AppModel
    @Environment(\.tokens) private var t
    @State private var note = ""

    private var placeholder: String {
        GoalCategory.all.first { $0.title == title }?.placeholder ?? "Anything you want me to plan around"
    }

    var body: some View {
        SheetContainer(title) {
            IntroText(Copy.goalSheetIntro, color: t.muted)
            TextArea(text: $note, placeholder: placeholder, identifier: "goal.note")
            ActionStack {
                PrimaryButton("Build the plan") { model.saveGoal(title, note: note) }
            }
        }
    }
}

/// A Tracking goal's sheet.
struct GoalOpenSheet: View {
    let title: String

    @Environment(\.tokens) private var t

    var body: some View {
        SheetContainer(title) {
            IntroText(Copy.goalOpenIntro, color: t.muted)
        }
    }
}

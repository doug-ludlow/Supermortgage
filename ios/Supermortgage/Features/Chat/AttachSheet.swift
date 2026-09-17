import SwiftUI

/// "Add to the conversation" — the composer's plus: a statement, a photo, a letter.
struct AttachSheet: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        SheetContainer("Add to the conversation") {
            VStack(spacing: 8) {
                ChoiceRow(icon: .file, title: "A statement", small: "Mortgage, tax bill, insurance renewal") {
                    model.attachPick("A mortgage statement")
                }
                ChoiceRow(icon: .camera, title: "A photo", small: "Anything with a number on it") {
                    model.attachPick("A photo of a bill")
                }
                ChoiceRow(icon: .edit, title: "A letter", small: "From a servicer, insurer or the county") {
                    model.attachPick("A letter from my servicer")
                }
            }
        }
    }
}

import SwiftUI

/// "Feed instructions" — a text area and Save.
struct InstructionsSheet: View {
    @EnvironmentObject private var model: AppModel
    @State private var text = ""

    var body: some View {
        SheetContainer("Feed instructions") {
            TextArea(text: $text, identifier: "instructions.text")
            ActionStack {
                PrimaryButton("Save") { model.saveInstructions(text) }
            }
        }
        .onAppear {
            if text.isEmpty { text = model.feedInstructions }
        }
    }
}

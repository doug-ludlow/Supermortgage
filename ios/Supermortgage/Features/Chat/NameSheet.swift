import SwiftUI

/// "Name your agent" — one text field and Save; empty falls back to Hazel.
struct NameSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.tokens) private var t
    @State private var name = ""
    @FocusState private var focused: Bool

    var body: some View {
        SheetContainer("Name your agent") {
            FieldBox(label: "Name") {
                TextField("Anything you like", text: $name)
                    .textStyle(.body)
                    .foregroundStyle(t.text)
                    .focused($focused)
                    .submitLabel(.done)
                    .onSubmit { model.saveName(name) }
                    .onChange(of: name) {
                        if name.count > 24 { name = String(name.prefix(24)) }
                    }
                    .accessibilityIdentifier("name.field")
            }
            ActionStack {
                PrimaryButton("Save") { model.saveName(name) }
            }
        }
        .onAppear {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { focused = true }
        }
    }
}

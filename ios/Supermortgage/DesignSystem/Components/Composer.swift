import SwiftUI

/// `.composer`: plus (Attach sheet), the "Message" field, and a send button that fills `button`
/// once the field has text.
struct Composer: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.tokens) private var t
    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 0) {
            Button { model.openAttach() } label: {
                Icon(.plus, size: 24)
                    .foregroundStyle(t.text)
                    .frame(width: 32, height: 42)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Add a document or photo")
            .accessibilityIdentifier("composer.attach")

            ZStack(alignment: .leading) {
                if text.isEmpty {
                    Text("Message")
                        .textStyle(.body)
                        .foregroundStyle(t.quiet)
                        .allowsHitTesting(false)
                }
                TextField("", text: $text)
                    .textStyle(.body)
                    .foregroundStyle(t.text)
                    .focused($focused)
                    .submitLabel(.send)
                    .onSubmit(send)
                    .accessibilityLabel("Message your agent")
                    .accessibilityIdentifier("composer.field")
            }
            .frame(minHeight: 42)
            .padding(.horizontal, 6)

            Button(action: send) {
                Icon(.up, size: 21)
                    .foregroundStyle(text.isEmpty ? t.quiet : Color.white)
                    .frame(width: 32, height: 32)
                    .background(text.isEmpty ? Color.clear : t.button)
                    .clipShape(Circle())
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Send")
            .accessibilityIdentifier("composer.send")
        }
        .padding(.horizontal, 9)
        .frame(height: 44)
        .background(t.chrome)
        .clipShape(Capsule())
        .overlay(Capsule().strokeBorder(t.chromeEdge, lineWidth: 1))
        .shadow(color: .black.opacity(t.shadowOpacity), radius: 16, x: 0, y: 8)
    }

    private func send() {
        let value = text
        guard !value.trimmed.isEmpty else { return }
        text = ""
        model.send(value)
    }
}

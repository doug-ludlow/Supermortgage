import SwiftUI

/// `.form-group` + `.field`: a 15pt `muted` label over a 44pt box with a 1pt `fieldLine` border and 8pt corners.
struct FieldBox<Content: View>: View {
    var label: String? = nil
    let content: Content

    @Environment(\.tokens) private var t

    init(label: String? = nil, @ViewBuilder content: () -> Content) {
        self.label = label
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let label {
                Text(label)
                    .textStyle(.support)
                    .foregroundStyle(t.muted)
            }
            HStack(spacing: 6) {
                content
            }
            .padding(.horizontal, 10)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(t.fieldLine, lineWidth: 1))
        }
        .padding(.vertical, 18)
    }
}

/// A read-only field (`input[readonly]`): the value in `muted`.
struct ReadOnlyField: View {
    let label: String
    let value: String

    @Environment(\.tokens) private var t

    var body: some View {
        FieldBox(label: label) {
            Text(value)
                .textStyle(.body)
                .foregroundStyle(t.muted)
                .lineLimit(1)
                .accessibilityIdentifier("field.\(label)")
        }
    }
}

/// An editable field with a prefix (the legacy `$`) — the Refinance cover's inputs.
struct TextFieldBox: View {
    let label: String
    var prefix: String? = nil
    var placeholder: String = ""
    @Binding var text: String

    @Environment(\.tokens) private var t

    var body: some View {
        FieldBox(label: label) {
            if let prefix {
                Text(prefix)
                    .textStyle(.body)
                    .foregroundStyle(t.muted)
            }
            TextField(placeholder, text: $text)
                .textStyle(.body)
                .foregroundStyle(t.text)
                .accessibilityIdentifier("field.\(label)")
        }
    }
}

/// `.ag-textarea`: a multi-line editor with a 1pt `fieldLine` border, 12pt corners, 15/20 text.
struct TextArea: View {
    @Binding var text: String
    var placeholder: String = ""
    var minHeight: CGFloat = 96
    var identifier: String = "textarea"

    @Environment(\.tokens) private var t

    var body: some View {
        ZStack(alignment: .topLeading) {
            if text.isEmpty && !placeholder.isEmpty {
                Text(placeholder)
                    .textStyle(.support)
                    .foregroundStyle(t.quiet)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 18)
                    .allowsHitTesting(false)
            }
            TextEditor(text: $text)
                .textStyle(.support)
                .foregroundStyle(t.text)
                .scrollContentBackground(.hidden)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .frame(minHeight: minHeight)
                .accessibilityIdentifier(identifier)
        }
        .background(Color.clear)
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(t.fieldLine, lineWidth: 1))
    }
}

/// `.check`: a 19pt checkbox with `accent` when checked, a 15pt label and a 12pt `muted` sub line.
struct CheckRow: View {
    let title: String
    var sub: String? = nil
    @Binding var checked: Bool

    @Environment(\.tokens) private var t

    var body: some View {
        Button { checked.toggle() } label: {
            HStack(alignment: .top, spacing: 10) {
                ZStack {
                    RoundedRectangle(cornerRadius: 4, style: .continuous)
                        .fill(checked ? t.accent : Color.clear)
                    RoundedRectangle(cornerRadius: 4, style: .continuous)
                        .strokeBorder(checked ? t.accent : t.quiet, lineWidth: 1.5)
                    if checked {
                        Icon(.check, size: 13, lineWidth: 2.4)
                            .foregroundStyle(.white)
                    }
                }
                .frame(width: 19, height: 19)
                .padding(.top, 1)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .textStyle(.support)
                        .foregroundStyle(t.text)
                    if let sub {
                        Text(sub)
                            .textStyle(.meta)
                            .foregroundStyle(t.muted)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, 13)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue(checked ? "Checked" : "Unchecked")
        .accessibilityIdentifier("check.\(title)")
    }
}

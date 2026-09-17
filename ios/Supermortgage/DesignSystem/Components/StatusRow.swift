import SwiftUI

/// `.status-row`: a spinner or a check, the copy, and an optional small line under it.
struct StatusRow: View {
    let text: String
    var small: String? = nil
    var done: Bool = true
    var spinnerTop: Color? = nil

    @Environment(\.tokens) private var t

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            if done {
                Icon(.check, size: 19)
                    .foregroundStyle(t.muted)
            } else {
                Spinner(size: 18, topColor: spinnerTop)
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(text)
                    .textStyle(.support)
                    .foregroundStyle(t.text)
                    .fixedSize(horizontal: false, vertical: true)
                if let small {
                    Text(small)
                        .textStyle(.meta)
                        .foregroundStyle(t.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }
}

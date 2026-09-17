import SwiftUI

/// `.list-row`: label left in `muted`, value right at weight 500, a `line` hairline above every row
/// but the first. 15/20, 12pt of padding.
struct ListRow<Value: View>: View {
    let key: String
    var first: Bool = false
    let value: Value

    @Environment(\.tokens) private var t

    init(_ key: String, first: Bool = false, @ViewBuilder value: () -> Value) {
        self.key = key
        self.first = first
        self.value = value()
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(key)
                .textStyle(.support)
                .foregroundStyle(t.muted)
            Spacer(minLength: 0)
            value
                .textStyle(.supportMedium)
                .foregroundStyle(t.text)
                .multilineTextAlignment(.trailing)
                .frame(maxWidth: 220, alignment: .trailing)
        }
        .padding(.top, first ? 0 : 12)
        .padding(.bottom, 12)
        .overlay(alignment: .top) {
            if !first { Rectangle().fill(t.line).frame(height: 1) }
        }
        .accessibilityElement(children: .combine)
    }
}

extension ListRow where Value == Text {
    init(_ key: String, _ value: String, first: Bool = false) {
        self.init(key, first: first) { Text(value) }
    }
}

/// `.ag-hist` / `.ag-next`: a text on the left, a `muted` date on the right, 10pt padding, hairlines.
struct HistoryList: View {
    let rows: [(text: String, when: String)]
    /// `.ag-next` draws the line above each row; `.ag-hist` below.
    var lineAbove: Bool = false

    @Environment(\.tokens) private var t

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(alignment: .top, spacing: 12) {
                    Text(row.text)
                        .textStyle(.support)
                        .foregroundStyle(t.text)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    Text(row.when)
                        .textStyle(.support)
                        .foregroundStyle(t.muted)
                        .lineLimit(1)
                }
                .padding(.vertical, 10)
                .overlay(alignment: lineAbove ? .top : .bottom) {
                    Rectangle().fill(t.line).frame(height: 1)
                }
            }
        }
    }
}

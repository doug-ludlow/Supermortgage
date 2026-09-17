import SwiftUI

struct Segment<Value: Hashable>: Identifiable {
    let value: Value
    let label: String
    var count: Int? = nil

    var id: Value { value }
}

/// `.ag-seg`: a `surface` pill with a `line` border, 5pt padding; the selected cell is `subtle` and
/// semibold; an optional `quiet` count follows the label.
struct SegmentedControl<Value: Hashable>: View {
    let segments: [Segment<Value>]
    @Binding var selection: Value

    @Environment(\.tokens) private var t

    var body: some View {
        HStack(spacing: 4) {
            ForEach(segments) { segment in
                let selected = segment.value == selection
                Button { selection = segment.value } label: {
                    HStack(spacing: 4) {
                        Text(segment.label)
                            .textStyle(selected ? .supportSemibold : .supportMedium)
                            .tracking(-0.2)
                            .foregroundStyle(selected ? t.text : t.muted)
                        if let count = segment.count {
                            Text("\(count)")
                                .textStyle(.support)
                                .foregroundStyle(t.quiet)
                        }
                    }
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                    .padding(.horizontal, 6)
                    .frame(maxWidth: .infinity, minHeight: 38)
                    .background(selected ? t.subtle : Color.clear)
                    .clipShape(Capsule())
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? .isSelected : [])
                .accessibilityIdentifier("segment.\(segment.label)")
            }
        }
        .padding(5)
        .background(t.surface)
        .clipShape(Capsule())
        .overlay(Capsule().strokeBorder(t.line, lineWidth: 1))
    }
}

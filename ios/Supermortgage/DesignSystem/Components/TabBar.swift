import SwiftUI

/// `.tab-bar`: 62pt pill on `chrome`, five equal cells, icons only; the selected cell is `selected`.
struct TabBar: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.tokens) private var t

    var body: some View {
        HStack(spacing: 0) {
            ForEach(ShellTab.allCases) { tab in
                Button { model.select(tab) } label: {
                    Icon(tab.icon, size: 27, lineWidth: 1.9)
                        .foregroundStyle(t.text)
                        .frame(maxWidth: .infinity, minHeight: 50)
                        .background(model.tab == tab ? t.selected : Color.clear)
                        .clipShape(Capsule())
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(tab.label)
                .accessibilityAddTraits(model.tab == tab ? .isSelected : [])
                .accessibilityIdentifier("tab.\(tab.rawValue.lowercased())")
            }
        }
        .padding(4)
        .frame(height: 62)
        .background(t.chrome)
        .clipShape(Capsule())
        .overlay(Capsule().strokeBorder(t.surface, lineWidth: 1))
        .shadow(color: .black.opacity(0.05), radius: 17, x: 0, y: 10)
        .padding(.horizontal, 5)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Main navigation")
    }
}

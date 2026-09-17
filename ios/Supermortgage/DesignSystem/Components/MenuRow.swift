import SwiftUI

/// `.ag-menu-row`: an icon in `quiet`, a 17pt title with an optional 15pt `muted` small line,
/// and a chevron; 56pt tall with a hairline below.
struct MenuRow: View {
    let icon: IconName
    let title: String
    var small: String? = nil
    let action: () -> Void

    @Environment(\.tokens) private var t

    var body: some View {
        Button(action: action) {
            HStack(alignment: .center, spacing: 12) {
                Icon(icon, size: 22)
                    .foregroundStyle(t.quiet)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .textStyle(.body)
                        .foregroundStyle(t.text)
                    if let small {
                        Text(small)
                            .textStyle(.support)
                            .foregroundStyle(t.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
                Icon(.arrow, size: 16)
                    .foregroundStyle(t.quiet)
            }
            .padding(.vertical, 12)
            .frame(minHeight: 56)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .bottomLine(t.line)
        .accessibilityIdentifier("menu.\(title)")
    }
}

/// `.ag-perm`: a 15pt medium title with a 12pt `muted` small line, and a trailing control.
struct PermRow<Trailing: View>: View {
    let title: String
    var small: String? = nil
    let trailing: Trailing

    @Environment(\.tokens) private var t

    init(_ title: String, small: String? = nil, @ViewBuilder trailing: () -> Trailing) {
        self.title = title
        self.small = small
        self.trailing = trailing()
    }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .textStyle(.supportMedium)
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
            trailing
        }
        .padding(.vertical, 12)
        .bottomLine(t.line)
    }
}

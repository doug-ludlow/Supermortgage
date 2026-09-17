import SwiftUI

/// `.ag-header`: menu button left, avatar + name pill + snippet centered, Invite right, on a
/// `paper` gradient that fades at the bottom. 128pt below the safe area.
struct HeaderBar: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.tokens) private var t

    var body: some View {
        ZStack(alignment: .top) {
            HStack(alignment: .top) {
                IconButton(icon: .menu, iconSize: 26, chrome: true, label: "Open menu") { model.openMenu() }
                    .accessibilityIdentifier("header.menu")
                Spacer()
                Button { model.openInvite() } label: {
                    Text("Invite")
                        .textStyle(.bodySemibold)
                        .tracking(-0.35)
                        .foregroundStyle(t.text)
                        .padding(.horizontal, 16)
                        .frame(minWidth: 73, minHeight: 44)
                        .background(t.chrome)
                        .clipShape(Capsule())
                        .overlay(Capsule().strokeBorder(t.surface, lineWidth: 1))
                        .shadow(color: .black.opacity(t.shadowOpacity), radius: 16, x: 0, y: 8)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("header.invite")
            }
            .padding(.top, 16)
            .padding(.leading, 20)
            .padding(.trailing, 16)

            Button { model.openAgent(.activity) } label: {
                VStack(spacing: 0) {
                    AvatarView(working: model.isWorking)
                        .padding(.vertical, -5)
                    Text(model.displayName)
                        .textStyle(.pill)
                        .foregroundStyle(t.text)
                        .lineLimit(1)
                        .padding(.vertical, 8)
                        .padding(.horizontal, 13)
                        .frame(maxWidth: 220)
                        .background(t.chrome)
                        .clipShape(Capsule())
                        .overlay(Capsule().strokeBorder(t.surface, lineWidth: 1))
                        .shadow(color: .black.opacity(t.shadowOpacity), radius: 16, x: 0, y: 8)
                        .padding(.top, -9)
                        .accessibilityIdentifier("header.name")
                    Text(model.snippet)
                        .textStyle(.meta)
                        .foregroundStyle(t.muted)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .frame(maxWidth: 260, minHeight: 16)
                        .padding(.top, 6)
                        .accessibilityIdentifier("header.snippet")
                }
                .frame(width: 280)
            }
            .buttonStyle(.plain)
            .padding(.top, 8)
            .accessibilityLabel("Agent status, activity and permissions")
            .accessibilityIdentifier("header.avatar")
        }
        .frame(maxWidth: .infinity)
        .frame(height: 128, alignment: .top)
        .background {
            LinearGradient(stops: [
                .init(color: t.paper, location: 0),
                .init(color: t.paper, location: 0.82),
                .init(color: t.paperGlass, location: 0.92),
                .init(color: t.paper.opacity(0), location: 1),
            ], startPoint: .top, endPoint: .bottom)
            .ignoresSafeArea(edges: .top)
        }
    }
}

import SwiftUI

/// Artifacts — the segments, the artifact rows or the media grid.
struct ArtifactsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.tokens) private var t

    private let columns = [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)]

    var body: some View {
        TabPage {
            ScreenTitle("Artifacts")
            SegmentedControl(
                segments: [
                    Segment(value: ArtifactsSegment.artifacts, label: "Artifacts", count: model.artifacts.count),
                    Segment(value: ArtifactsSegment.media, label: "Media", count: model.media.count),
                ],
                selection: $model.artifactsSegment)
                .padding(.bottom, 18)
            if model.artifactsSegment == .artifacts {
                ForEach(model.artifacts) { artifact in
                    ArtRow(artifact: artifact) { model.openArtifact(artifact.id) }
                }
            } else {
                LazyVGrid(columns: columns, spacing: 10) {
                    ForEach(model.media) { item in
                        MediaTile(item: item)
                    }
                }
            }
        }
        .accessibilityIdentifier("screen.artifacts")
    }
}

/// `.ag-media`: a 3:4 `surface` tile with an icon and a 12pt caption.
struct MediaTile: View {
    let item: MediaItem

    @Environment(\.tokens) private var t

    var body: some View {
        VStack(spacing: 8) {
            Icon(item.kind.icon, size: 26)
                .foregroundStyle(t.quiet)
            Text(item.title)
                .textStyle(.meta)
                .foregroundStyle(t.muted)
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .aspectRatio(3 / 4, contentMode: .fit)
        .background(t.surface)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(t.cardLine, lineWidth: 1))
        .shadow(color: .black.opacity(t.cardShadowOpacity), radius: 12.5, x: 0, y: 7)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(item.title)
    }
}

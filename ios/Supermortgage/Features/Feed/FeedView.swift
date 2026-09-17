import SwiftUI

/// The feed: the day label, the instructions card, posts newest first (or the empty state).
struct FeedView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.tokens) private var t

    var body: some View {
        TabPage {
            Text(Format.dayLabel())
                .textStyle(.title)
                .foregroundStyle(t.text)
                .padding(.top, 12)
                .padding(.bottom, 14)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("feed.day")
            if !model.instructionsDismissed {
                FeedInstructionsCard()
                    .padding(.bottom, 6)
            }
            if model.feed.isEmpty {
                emptyState
            } else {
                ForEach(model.feed) { post in
                    PostRow(post: post)
                }
            }
        }
        .accessibilityIdentifier("screen.feed")
    }

    private var emptyState: some View {
        VStack(spacing: 0) {
            Icon(.feed, size: 40)
                .foregroundStyle(t.quiet)
                .padding(.bottom, 18)
            Text(Copy.feedEmptyTitle)
                .textStyle(.bodySemibold)
                .tracking(0)
                .foregroundStyle(t.muted)
                .padding(.bottom, 6)
            Text(Copy.feedEmptyBody)
                .textStyle(.support)
                .foregroundStyle(t.muted)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 170)
        .accessibilityIdentifier("feed.empty")
    }
}

/// `.ag-instr`: the Feed instructions card with Edit and Got it.
struct FeedInstructionsCard: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.tokens) private var t

    var body: some View {
        Card {
            Text(Copy.feedInstructionsTitle)
                .textStyle(.bodySemibold)
                .foregroundStyle(t.text)
                .padding(.bottom, 6)
            Text(Copy.feedInstructionsIntro)
                .textStyle(.support)
                .foregroundStyle(t.muted)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.bottom, 12)
            Text(model.feedInstructions)
                .textStyle(.support)
                .foregroundStyle(t.text)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 12)
                .padding(.bottom, 14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .topLine(t.line)
                .accessibilityIdentifier("feed.instructions")
            HStack(spacing: 10) {
                SecondaryButton("Edit") { model.editInstructions() }
                PrimaryButton("Got it") { model.gotIt() }
            }
        }
    }
}

/// `.ag-post`: the emoji, title (+ tag), body, and the heart · Discuss · Open · info row.
struct PostRow: View {
    let post: Post

    @EnvironmentObject private var model: AppModel
    @Environment(\.tokens) private var t

    private var liked: Bool { model.liked.contains(post.id) }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text(post.icon)
                .font(.system(size: 30))
                .frame(width: 44)
                .padding(.top, 1)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(post.title)
                        .textStyle(.bodySemibold)
                        .foregroundStyle(t.text)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("post.title.\(post.id)")
                    if let tag = post.tag {
                        Chip(text: tag, tag: true)
                    }
                }
                .padding(.bottom, 6)
                Text(post.body)
                    .textStyle(.support)
                    .foregroundStyle(t.muted)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(alignment: .center, spacing: 18) {
                    Button { model.toggleLike(post.id) } label: {
                        Icon(.heart, size: 22, fill: liked)
                            .foregroundStyle(liked ? t.accent : t.text)
                            .frame(minHeight: 28)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Like")
                    .accessibilityIdentifier("post.like.\(post.id)")
                    Button { model.discuss(post.id) } label: {
                        HStack(spacing: 6) {
                            Icon(.chat, size: 22)
                            Text("Discuss")
                                .textStyle(.support)
                        }
                        .foregroundStyle(t.text)
                        .frame(minHeight: 28)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("post.discuss.\(post.id)")
                    if let action = post.action {
                        Button { model.open(action) } label: {
                            Text("Open")
                                .textStyle(.support)
                                .foregroundStyle(t.muted)
                                .frame(minHeight: 28)
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("post.open.\(post.id)")
                    }
                    Spacer(minLength: 0)
                    Button { model.openWhy(post.id) } label: {
                        Icon(.info, size: 22)
                            .foregroundStyle(t.text)
                            .frame(minHeight: 28)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Why this post")
                    .accessibilityIdentifier("post.why.\(post.id)")
                }
                .padding(.top, 12)
            }
        }
        .padding(.vertical, 18)
        .bottomLine(t.line)
    }
}

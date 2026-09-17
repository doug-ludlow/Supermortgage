import SwiftUI

/// `<dialog>`: the bottom sheet chrome — grabber, title row with a round close button, and a
/// scrolling body. Presented with `.medium`/`.large` detents, 30pt top corners, `paper` background.
struct SheetContainer<Content: View>: View {
    let title: String
    /// Overrides the close action (the Refinance cover hosts its own Invite sheet).
    var onClose: (() -> Void)? = nil
    let content: Content

    @EnvironmentObject private var router: Router
    @Environment(\.tokens) private var t

    init(_ title: String, onClose: (() -> Void)? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.onClose = onClose
        self.content = content()
    }

    var body: some View {
        VStack(spacing: 0) {
            Capsule()
                .fill(t.handle)
                .frame(width: 32, height: 4)
                .padding(.top, 8)
                .padding(.bottom, 12)
            HStack(alignment: .center, spacing: 10) {
                Text(title)
                    .textStyle(.sheetTitle)
                    .foregroundStyle(t.text)
                    .accessibilityIdentifier("sheet.title")
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 0)
                Button { if let onClose { onClose() } else { router.dismiss() } } label: {
                    Icon(.close, size: 18)
                        .foregroundStyle(t.text)
                        .frame(width: 32, height: 32)
                        .background(t.bubble)
                        .clipShape(Circle())
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close")
                .accessibilityIdentifier("sheet.close")
            }
            .padding(.bottom, 20)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    content
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.bottom, 24)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .padding(.horizontal, 20)
        .background(t.paper)
    }
}

/// A `.ag-sheet-section`: a 17pt semibold heading with 6pt below, 18pt above.
struct SheetSection<Content: View>: View {
    let title: String
    let content: Content

    @Environment(\.tokens) private var t

    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title)
                .textStyle(.bodySemibold)
                .foregroundStyle(t.text)
                .padding(.bottom, 6)
            content
        }
        .padding(.top, 18)
    }
}

/// `.ag-h2`: the sheet and screen sub-headings — 17pt semibold, 26pt above, 4pt below.
struct SectionHeading: View {
    let text: String
    var top: CGFloat = 26

    @Environment(\.tokens) private var t

    init(_ text: String, top: CGFloat = 26) {
        self.text = text
        self.top = top
    }

    var body: some View {
        Text(text)
            .textStyle(.bodySemibold)
            .foregroundStyle(t.text)
            .padding(.top, top)
            .padding(.bottom, 4)
            .accessibilityAddTraits(.isHeader)
    }
}

/// `.intro`: 15/20 with 20pt below.
struct IntroText: View {
    let text: String
    var color: Color? = nil

    @Environment(\.tokens) private var t

    init(_ text: String, color: Color? = nil) {
        self.text = text
        self.color = color
    }

    var body: some View {
        Text(text)
            .textStyle(.support)
            .foregroundStyle(color ?? t.text)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.bottom, 20)
    }
}

/// `.fine`: 12/16 `muted`, 12pt above and below.
struct FineText: View {
    let text: String

    @Environment(\.tokens) private var t

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .textStyle(.meta)
            .foregroundStyle(t.muted)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.vertical, 12)
    }
}

/// `.ag-actions`: a stack of buttons with 10pt gaps and 20pt above.
struct ActionStack<Content: View>: View {
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        VStack(spacing: 10) {
            content
        }
        .padding(.top, 20)
    }
}

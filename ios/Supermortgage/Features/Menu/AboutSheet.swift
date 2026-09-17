import SwiftUI

/// About Supermortgage — four short sections and the fictional-data line.
struct AboutSheet: View {
    @Environment(\.tokens) private var t

    var body: some View {
        SheetContainer("About Supermortgage") {
            SectionHeading("What is Supermortgage?", top: 0)
            IntroText(Copy.aboutWhat, color: t.muted)
            SectionHeading("How does it work?")
            IntroText(Copy.aboutHow, color: t.muted)
            SectionHeading("Three kinds of work")
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(Copy.aboutKinds.enumerated()), id: \.offset) { _, kind in
                    (Text(kind.label).fontWeight(.semibold) + Text(kind.text))
                        .textStyle(.support)
                        .foregroundStyle(t.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.bottom, 20)
            SectionHeading("How does it make money?")
            IntroText(Copy.aboutMoney, color: t.muted)
            FineText(Copy.aboutFine)
        }
    }
}

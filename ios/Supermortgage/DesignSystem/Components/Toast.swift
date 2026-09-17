import SwiftUI

/// `#ag-toast`: a dark pill, white 15pt text, that sits 152pt above the bottom for 2.2s.
struct Toast: View {
    let text: String

    var body: some View {
        Text(text)
            .textStyle(.support)
            .foregroundStyle(.white)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(Color(hex: 0x252525))
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
            .padding(.horizontal, 20)
            .accessibilityIdentifier("toast")
    }
}

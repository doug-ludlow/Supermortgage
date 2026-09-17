import SwiftUI

/// "Connect your accounts" — Northstar Bank, three checked accounts, Continue.
struct PlaidSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.tokens) private var t
    @State private var checked: [Bool] = [true, true, true]

    var body: some View {
        SheetContainer("Connect your accounts") {
            HStack(spacing: 12) {
                Text("N")
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(t.paper)
                    .frame(width: 40, height: 40)
                    .background(t.text)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 0) {
                    Text("Northstar Bank")
                        .textStyle(.bodySemibold)
                        .foregroundStyle(t.text)
                    Text("Plaid · demo")
                        .textStyle(.support)
                        .foregroundStyle(t.muted)
                }
            }
            .padding(.bottom, 6)
            IntroText(Copy.plaidIntro, color: t.muted)
            ForEach(Array(Copy.plaidAccounts.enumerated()), id: \.offset) { index, account in
                CheckRow(title: account.title, sub: account.sub, checked: $checked[index])
            }
            ActionStack {
                PrimaryButton("Continue") {
                    model.plaidDone(accounts: checked.filter { $0 }.count)
                }
            }
        }
    }
}

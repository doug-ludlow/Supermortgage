import SwiftUI

/// The one sanctioned departure from the HTML (§5.10): instead of the embedded legacy Apply web
/// prototype, a full-screen cover with one screen, "Your current home.", prefilled from `Home`.
/// Continue shows "Handing your file to the platform…" for 1.2s and dismisses; Hand back dismisses.
/// Dismissing either way returns to the chat, where the agent says it has it from here.
struct RefinanceCover: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var router: Router
    @Environment(\.tokens) private var t
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var address = Home.address
    @State private var goal = "Lower payment"
    @State private var homeValue = "410,000"
    @State private var balance = "287,400"
    @State private var occupancy = "Main home"
    @State private var propertyType = "Single-family"
    @State private var units = "1"
    @State private var hoa = "0"
    @State private var otherLiens = "0"
    @State private var detailsOpen = false
    @State private var handing = false
    @State private var inviteShown = false

    private let goals = ["Lower payment", "Pay off sooner", "Take cash out"]
    private let occupancies = ["Main home", "Second home", "Investment property"]
    private let propertyTypes = ["Single-family", "Condominium", "Townhouse", "2–4 unit property", "Manufactured home"]

    var body: some View {
        RefinanceCoverContent(
            address: $address, goal: $goal, homeValue: $homeValue, balance: $balance, occupancy: $occupancy,
            propertyType: $propertyType, units: $units, hoa: $hoa, otherLiens: $otherLiens,
            detailsOpen: $detailsOpen, handing: $handing, inviteShown: $inviteShown,
            goals: goals, occupancies: occupancies, propertyTypes: propertyTypes,
            onContinue: continueTapped, onBack: handBack)
            .resolvedTokens()
            .preferredColorScheme(model.theme.colorScheme)
    }

    private func continueTapped() {
        guard !handing else { return }
        handing = true
        model.run { [weak model] in
            guard let model else { return }
            do { try await model.clock.sleep(ms: 1200) } catch { return }
            model.router.refinanceShown = false
        }
    }

    private func handBack() {
        router.refinanceShown = false
    }
}

private struct RefinanceCoverContent: View {
    @Binding var address: String
    @Binding var goal: String
    @Binding var homeValue: String
    @Binding var balance: String
    @Binding var occupancy: String
    @Binding var propertyType: String
    @Binding var units: String
    @Binding var hoa: String
    @Binding var otherLiens: String
    @Binding var detailsOpen: Bool
    @Binding var handing: Bool
    @Binding var inviteShown: Bool
    let goals: [String]
    let occupancies: [String]
    let propertyTypes: [String]
    let onContinue: () -> Void
    let onBack: () -> Void

    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var router: Router
    @Environment(\.tokens) private var t
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            t.paper.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Text(Copy.refinanceTitle)
                        .textStyle(.title)
                        .foregroundStyle(t.text)
                        .padding(.bottom, 22)
                        .accessibilityAddTraits(.isHeader)
                        .accessibilityIdentifier("refinance.title")
                    TextFieldBox(label: "Property address", text: $address)
                    SelectField(label: "Your goal", options: goals, selection: $goal)
                    HStack(alignment: .top, spacing: 12) {
                        TextFieldBox(label: "Estimated home value", prefix: "$", text: $homeValue)
                        TextFieldBox(label: "Mortgage balance", prefix: "$", text: $balance)
                    }
                    .padding(.vertical, -12)
                    SelectField(label: "How will you use it?", options: occupancies, selection: $occupancy)
                    propertyDetails
                    if handing {
                        StatusRow(text: Copy.handingOff, done: false)
                            .padding(.top, 18)
                            .accessibilityIdentifier("refinance.handing")
                    }
                    PrimaryButton("Continue") { onContinue() }
                        .padding(.top, 24)
                        .accessibilityIdentifier("refinance.continue")
                    LinkButton("Use a sample statement") { }
                        .frame(maxWidth: .infinity)
                }
                .padding(.top, 18)
                .padding(.horizontal, 16)
                .padding(.bottom, 40)
            }
            .scrollDismissesKeyboard(.interactively)
            .safeAreaInset(edge: .top, spacing: 0) { header }
            .safeAreaInset(edge: .bottom, spacing: 0) { bottomBar }
        }
        .overlay(alignment: .bottom) {
            if let text = router.toastText {
                Toast(text: text)
                    .padding(.bottom, 152)
                    .transition(reduceMotion ? .identity : .opacity.combined(with: .offset(y: 8)))
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.18), value: router.toastText)
        .sheet(isPresented: $inviteShown) {
            InviteSheet(onClose: { inviteShown = false })
                .environmentObject(model)
                .environmentObject(router)
                .resolvedTokens()
                .preferredColorScheme(model.theme.colorScheme)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.hidden)
                .presentationCornerRadius(30)
                .presentationBackground(model.theme == .dark ? Tokens.dark.paper : Tokens.light.paper)
        }
        .screenEnter()
        .accessibilityIdentifier("screen.refinance")
    }

    /// `.header`: back chevron, the "s" mark over the "Supermortgage" pill, Invite.
    private var header: some View {
        ZStack(alignment: .top) {
            HStack(alignment: .top) {
                IconButton(icon: .back, iconSize: 26, chrome: true, label: "Previous step") { onBack() }
                    .accessibilityIdentifier("refinance.back")
                Spacer()
                Button { inviteShown = true } label: {
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
                .accessibilityIdentifier("refinance.invite")
            }
            .padding(.top, 16)
            .padding(.leading, 20)
            .padding(.trailing, 16)
            VStack(spacing: 0) {
                BrandMark(size: 67)
                    .frame(width: 55, height: 53)
                    .padding(.trailing, 5)
                    .padding(.bottom, 4)
                Text("Supermortgage")
                    .textStyle(.pill)
                    .foregroundStyle(t.text)
                    .padding(.vertical, 8)
                    .padding(.horizontal, 13)
                    .background(t.chrome)
                    .clipShape(Capsule())
                    .overlay(Capsule().strokeBorder(t.surface, lineWidth: 1))
                    .shadow(color: .black.opacity(t.shadowOpacity), radius: 16, x: 0, y: 8)
            }
            .padding(.top, 14)
            .accessibilityHidden(true)
        }
        .frame(maxWidth: .infinity)
        .frame(height: 114, alignment: .top)
        .background {
            LinearGradient(stops: [
                .init(color: t.paper, location: 0),
                .init(color: t.paperGlass, location: 0.75),
                .init(color: t.paper.opacity(0), location: 1),
            ], startPoint: .top, endPoint: .bottom)
            .ignoresSafeArea(edges: .top)
        }
    }

    /// `.ag-apply-bar`: "Hand back to {name}" on `chrome`.
    private var bottomBar: some View {
        Button(action: onBack) {
            HStack(spacing: 8) {
                Icon(.back, size: 20)
                Text("Hand back to \(model.name.isEmpty ? "your agent" : model.name)")
                    .textStyle(.button)
            }
            .foregroundStyle(t.text)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(t.chrome)
            .clipShape(Capsule())
            .overlay(Capsule().strokeBorder(t.surface, lineWidth: 1))
            .shadow(color: .black.opacity(t.shadowOpacity), radius: 16, x: 0, y: 8)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .padding(.top, 12)
        .padding(.horizontal, 16)
        .padding(.bottom, 16)
        .background {
            LinearGradient(stops: [
                .init(color: t.paperFade.opacity(0), location: 0),
                .init(color: t.paperFade, location: 0.55),
                .init(color: t.paperFade, location: 1),
            ], startPoint: .top, endPoint: .bottom)
            .ignoresSafeArea(edges: .bottom)
        }
        .accessibilityIdentifier("refinance.handback")
    }

    /// `<details>` "Property details": the legacy summary row with its + / − marker.
    private var propertyDetails: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { detailsOpen.toggle() } label: {
                HStack(spacing: 10) {
                    Text("Property details")
                        .textStyle(.support)
                        .foregroundStyle(t.text)
                    Spacer(minLength: 0)
                    Text(detailsOpen ? "−" : "+")
                        .font(.system(size: 23, weight: .light))
                        .foregroundStyle(t.quiet)
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("refinance.details")
            if detailsOpen {
                SelectField(label: "Property type", options: propertyTypes, selection: $propertyType)
                HStack(alignment: .top, spacing: 12) {
                    TextFieldBox(label: "Units", text: $units)
                    TextFieldBox(label: "HOA / month", prefix: "$", text: $hoa)
                }
                .padding(.vertical, -12)
                TextFieldBox(label: "Other liens to pay off", prefix: "$", text: $otherLiens)
            }
        }
        .padding(.bottom, 8)
        .padding(.vertical, 10)
        .bottomLine(t.line)
    }
}

/// A `<select>`-style field: the label over a 44pt box showing the choice, with a menu of options.
struct SelectField: View {
    let label: String
    let options: [String]
    @Binding var selection: String

    @Environment(\.tokens) private var t

    var body: some View {
        FieldBox(label: label) {
            Menu {
                ForEach(options, id: \.self) { option in
                    Button(option) { selection = option }
                }
            } label: {
                HStack {
                    Text(selection)
                        .textStyle(.body)
                        .foregroundStyle(t.text)
                    Spacer(minLength: 0)
                    Icon(.arrow, size: 16)
                        .foregroundStyle(t.quiet)
                        .rotationEffect(.degrees(90))
                }
                .frame(minHeight: 42)
                .contentShape(Rectangle())
            }
            .accessibilityIdentifier("select.\(label)")
        }
    }
}

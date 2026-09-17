import SwiftUI

/// The avatar sheet: the status line, Activity · Permissions · Memory, and Pause everything.
struct AgentSheet: View {
    let initialSegment: AgentSegment

    @EnvironmentObject private var model: AppModel
    @Environment(\.tokens) private var t
    @State private var segment: AgentSegment
    @State private var permissionStates: [String: Bool] = [:]
    @State private var memoryText = ""

    init(initialSegment: AgentSegment) {
        self.initialSegment = initialSegment
        _segment = State(initialValue: initialSegment)
    }

    private var statusText: String {
        model.paused ? "Paused" : "Working on: \(Copy.snippets[model.snippetIndex % Copy.snippets.count].lowercased())"
    }

    var body: some View {
        SheetContainer(model.agentTitle) {
            HStack(spacing: 10) {
                Spinner()
                Text(statusText)
                    .textStyle(.support)
                    .foregroundStyle(t.muted)
                    .lineLimit(1)
                    .accessibilityIdentifier("agent.status")
            }
            .padding(.top, -8)
            .padding(.bottom, 14)
            SegmentedControl(
                segments: AgentSegment.allCases.map { Segment(value: $0, label: $0.label) },
                selection: $segment)
                .padding(.bottom, 18)
            switch segment {
            case .activity: activity
            case .permissions: permissions
            case .memory: memory
            }
            PermRow(Copy.pauseEverything, small: Copy.pauseEverythingSmall) {
                SwitchToggle(isOn: Binding(get: { model.paused }, set: { model.setPaused($0) }), identifier: "agent.pause")
            }
            .padding(.top, 18)
            .topLine(t.line)
        }
        .onAppear {
            if memoryText.isEmpty { memoryText = model.memoryDisplay }
        }
    }

    @ViewBuilder
    private var activity: some View {
        if model.log.isEmpty {
            IntroText(Copy.activityEmpty, color: t.muted)
        } else {
            HistoryList(rows: model.log.map { (text: $0.text, when: $0.at) })
        }
    }

    private func permissionBinding(_ permission: Permission) -> Binding<Bool> {
        Binding(
            get: { permissionStates[permission.id] ?? (permission.mode == .own) },
            set: { value in
                permissionStates[permission.id] = value
                model.permissionToggled(on: value)
            })
    }

    @ViewBuilder
    private var permissions: some View {
        SectionHeading("Does on its own", top: 4)
        ForEach(Permissions.doesOnItsOwn) { permission in
            PermRow(permission.title, small: permission.detail) {
                SwitchToggle(isOn: permissionBinding(permission), identifier: "perm.\(permission.title)")
            }
        }
        SectionHeading("Asks first")
        ForEach(Permissions.asksFirst) { permission in
            PermRow(permission.title, small: permission.detail) {
                SwitchToggle(isOn: permissionBinding(permission), identifier: "perm.\(permission.title)")
            }
        }
        FineText(Copy.permissionsFine)
    }

    @ViewBuilder
    private var memory: some View {
        IntroText(Copy.memoryIntro, color: t.muted)
        TextArea(text: $memoryText, minHeight: 220, identifier: "agent.memory")
        ActionStack {
            PrimaryButton("Save") { model.saveMemory(memoryText) }
        }
    }
}

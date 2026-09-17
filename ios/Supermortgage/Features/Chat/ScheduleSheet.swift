import SwiftUI

/// "Talk to a person" — two call slots.
struct ScheduleSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.tokens) private var t

    var body: some View {
        SheetContainer("Talk to a person") {
            IntroText(Copy.scheduleIntro, color: t.muted)
            VStack(spacing: 8) {
                ForEach(Copy.scheduleSlots, id: \.self) { slot in
                    ChoiceRow(title: slot) { model.scheduled(slot) }
                }
            }
        }
    }
}

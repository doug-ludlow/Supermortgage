import SwiftUI

/// `spark()`: 60pt tall; a dashed `accentSoft` line for the plan and a solid `accent` line for
/// what has happened, both mapped point for point from the value range.
struct Sparkline: View {
    let happened: [Double]
    let plan: [Double]

    @Environment(\.tokens) private var t

    var body: some View {
        GeometryReader { geo in
            let width = geo.size.width
            let height: CGFloat = 60
            let maxValue = plan.max() ?? 1
            let minValue = (plan.min() ?? 0) - 200
            let count = max(plan.count, 2)
            let point: (Double, Int) -> CGPoint = { value, index in
                let x = CGFloat(index) / CGFloat(count - 1) * width
                let span = CGFloat(maxValue - minValue)
                let y = height - CGFloat(value - minValue) / (span == 0 ? 1 : span) * (height - 6) - 3
                return CGPoint(x: x, y: y)
            }
            ZStack {
                Path { path in
                    for (i, v) in plan.enumerated() {
                        let p = point(v, i)
                        if i == 0 { path.move(to: p) } else { path.addLine(to: p) }
                    }
                }
                .stroke(t.accentSoft, style: StrokeStyle(lineWidth: 3, dash: [4, 4]))
                Path { path in
                    for (i, v) in happened.enumerated() {
                        let p = point(v, i)
                        if i == 0 { path.move(to: p) } else { path.addLine(to: p) }
                    }
                }
                .stroke(t.accent, style: StrokeStyle(lineWidth: 3, lineCap: .round))
            }
        }
        .frame(height: 60)
        .accessibilityHidden(true)
    }
}

import SwiftUI

/// `P` in the prototype: every icon as SVG path data in a 24×24 box, stroked 1.8, round caps and joins.
enum IconName: String, CaseIterable {
    case back, arrow, up, menu, plus, close, check, home, refresh, wallet, clock, shield, bank, work, user, file, spark,
         lock, chat, edit, feed, goals, art, heart, info, dots, bolt, camera, image, target, mic, link, download, sliders,
         pause, calendar, chart, sun, moon, minus

    var pathData: String {
        switch self {
        case .back: return "M14 5l-7 7 7 7"
        case .arrow: return "M9 5l7 7-7 7"
        case .up: return "M12 19V5m-6 6 6-6 6 6"
        case .menu: return "M5 8h14M5 16h14"
        case .plus: return "M12 5v14M5 12h14"
        case .close: return "m6 6 12 12M6 18 18 6"
        case .check: return "m5 12 4 4L19 6"
        case .home: return "m3 11 9-8 9 8M5 10v11h5v-7h4v7h5V10"
        case .refresh: return "M20 7v5h-5M4 17v-5h5M19 12a7 7 0 0 0-12-5L4 10m1 2a7 7 0 0 0 12 5l3-3"
        case .wallet: return "M3 7h17v13H3V5l14-2v4M20 12h-6v4h6"
        case .clock: return "M12 8v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0"
        case .shield: return "m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3m-4 9 3 3 5-6"
        case .bank: return "m3 8 9-5 9 5H3m0 13h18M5 11v7m7-7v7m7-7v7"
        case .work: return "M8 6V3h8v3M3 6h18v14H3V6m0 6h18"
        case .user: return "M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M4 21v-2a8 8 0 0 1 16 0v2"
        case .file: return "M14 3H5v18h14V8l-5-5v5h5M8 12h8m-8 4h6"
        case .spark: return "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3"
        case .lock: return "M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5V10m7 4v3"
        case .chat: return "M21 4H3v13h5v4l5-4h8V4"
        case .edit: return "m14 4 6 6M4 20l5-1L21 7l-4-4L5 15l-1 5"
        case .feed: return "M4 5h16v14H4zM8 9h8M8 13h5M8 17h3"
        case .goals: return "M4 4h16v16H4zM8 12l3 3 5-6"
        case .art: return "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"
        case .heart: return "M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10"
        case .info: return "M12 8h.01M11 12h1v4h1M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0"
        case .dots: return "M6 12h.01M12 12h.01M18 12h.01"
        case .bolt: return "M13 2 4 14h7l-1 8 9-12h-7z"
        case .camera: return "M4 8h4l2-3h4l2 3h4v11H4zM12 17a3 3 0 1 0 0-6 3 3 0 0 0 0 6"
        case .image: return "M4 5h16v14H4zM8 10a1 1 0 1 0 0-2 1 1 0 0 0 0 2m-4 7 5-5 4 4 3-3 4 4"
        case .target: return "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18m0-5a4 4 0 1 0 0-8 4 4 0 0 0 0 8m0-4h.01"
        case .mic: return "M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3m-6-3a6 6 0 0 0 12 0M12 18v3"
        case .link: return "M10 14a4 4 0 0 0 5.6 0l3-3a4 4 0 0 0-5.6-5.6l-1 1M14 10a4 4 0 0 0-5.6 0l-3 3a4 4 0 0 0 5.6 5.6l1-1"
        case .download: return "M12 4v12m-5-5 5 5 5-5M4 20h16"
        case .sliders: return "M4 6h10M18 6h2M4 12h2M10 12h10M4 18h12M20 18h2"
        case .pause: return "M8 5v14M16 5v14"
        case .calendar: return "M4 6h16v15H4zM4 10h16M8 3v4m8-4v4"
        case .chart: return "M4 20V4m0 16h16M8 16v-5m4 5V8m4 8v-3"
        case .sun: return "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10M12 2v2m0 16v2M4 12H2m20 0h-2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"
        case .moon: return "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5"
        case .minus: return "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M8 12h8"
        }
    }

    var path: Path { SVGPath.path(pathData) }
}

/// A stroked icon from the prototype's set, in `foregroundStyle`, at `size` points.
struct Icon: View {
    let name: IconName
    var size: CGFloat = 24
    var lineWidth: CGFloat = 1.8
    var fill: Bool = false

    init(_ name: IconName, size: CGFloat = 24, lineWidth: CGFloat = 1.8, fill: Bool = false) {
        self.name = name
        self.size = size
        self.lineWidth = lineWidth
        self.fill = fill
    }

    var body: some View {
        let scale = size / 24
        let path = name.path.applying(CGAffineTransform(scaleX: scale, y: scale))
        ZStack {
            if fill {
                path.fill(.primary)
            }
            path.stroke(style: StrokeStyle(lineWidth: lineWidth * scale, lineCap: .round, lineJoin: .round))
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

extension ShellTab {
    var icon: IconName {
        switch self {
        case .chat: return .chat
        case .feed: return .feed
        case .work: return .work
        case .goals: return .goals
        case .artifacts: return .art
        }
    }
}

extension MediaKind {
    var icon: IconName {
        switch self {
        case .file: return .file
        case .camera: return .camera
        }
    }
}

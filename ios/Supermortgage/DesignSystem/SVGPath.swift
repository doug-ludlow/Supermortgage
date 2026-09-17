import SwiftUI

/// A small SVG path-data reader for the prototype's icons and avatar: the commands
/// M m L l H h V v C c S s Q q T t A a Z z, with arcs converted to cubic curves.
enum SVGPath {
    private enum Token {
        case command(Character)
        case number(CGFloat)
    }

    static func path(_ d: String) -> Path {
        var path = Path()
        let tokens = tokenize(d)
        var i = 0
        var cmd: Character = "M"
        var lastCmd: Character = "M"
        var cur = CGPoint.zero
        var start = CGPoint.zero
        var lastControl: CGPoint?

        func number() -> CGFloat? {
            guard i < tokens.count, case .number(let v) = tokens[i] else { return nil }
            i += 1
            return v
        }
        func point() -> CGPoint? {
            guard let x = number(), let y = number() else { return nil }
            return CGPoint(x: x, y: y)
        }
        func absolute(_ p: CGPoint, relative: Bool) -> CGPoint {
            relative ? CGPoint(x: cur.x + p.x, y: cur.y + p.y) : p
        }
        func reflect(_ c: CGPoint?, about p: CGPoint) -> CGPoint {
            guard let c else { return p }
            return CGPoint(x: 2 * p.x - c.x, y: 2 * p.y - c.y)
        }

        while i < tokens.count {
            if case .command(let c) = tokens[i] {
                cmd = c
                i += 1
            } else if cmd == "M" {
                cmd = "L"
            } else if cmd == "m" {
                cmd = "l"
            }
            let relative = cmd.isLowercase
            let upper = Character(String(cmd).uppercased())
            switch upper {
            case "M":
                guard let p = point() else { return path }
                cur = absolute(p, relative: relative)
                start = cur
                path.move(to: cur)
                lastControl = nil
            case "L":
                guard let p = point() else { return path }
                cur = absolute(p, relative: relative)
                path.addLine(to: cur)
                lastControl = nil
            case "H":
                guard let x = number() else { return path }
                cur = CGPoint(x: relative ? cur.x + x : x, y: cur.y)
                path.addLine(to: cur)
                lastControl = nil
            case "V":
                guard let y = number() else { return path }
                cur = CGPoint(x: cur.x, y: relative ? cur.y + y : y)
                path.addLine(to: cur)
                lastControl = nil
            case "C":
                guard let c1 = point(), let c2 = point(), let p = point() else { return path }
                let a1 = absolute(c1, relative: relative)
                let a2 = absolute(c2, relative: relative)
                let end = absolute(p, relative: relative)
                path.addCurve(to: end, control1: a1, control2: a2)
                lastControl = a2
                cur = end
            case "S":
                guard let c2 = point(), let p = point() else { return path }
                let prevWasCubic = lastCmd == "C" || lastCmd == "S"
                let a1 = prevWasCubic ? reflect(lastControl, about: cur) : cur
                let a2 = absolute(c2, relative: relative)
                let end = absolute(p, relative: relative)
                path.addCurve(to: end, control1: a1, control2: a2)
                lastControl = a2
                cur = end
            case "Q":
                guard let c = point(), let p = point() else { return path }
                let control = absolute(c, relative: relative)
                let end = absolute(p, relative: relative)
                path.addQuadCurve(to: end, control: control)
                lastControl = control
                cur = end
            case "T":
                guard let p = point() else { return path }
                let prevWasQuad = lastCmd == "Q" || lastCmd == "T"
                let control = prevWasQuad ? reflect(lastControl, about: cur) : cur
                let end = absolute(p, relative: relative)
                path.addQuadCurve(to: end, control: control)
                lastControl = control
                cur = end
            case "A":
                guard let rx = number(), let ry = number(), let rotation = number(),
                      let large = number(), let sweep = number(), let p = point() else { return path }
                let end = absolute(p, relative: relative)
                addArc(&path, from: cur, to: end, rx: rx, ry: ry, rotationDegrees: rotation, largeArc: large != 0, sweep: sweep != 0)
                cur = end
                lastControl = nil
            case "Z":
                path.closeSubpath()
                cur = start
                lastControl = nil
            default:
                return path
            }
            lastCmd = upper
        }
        return path
    }

    private static func tokenize(_ d: String) -> [Token] {
        var tokens: [Token] = []
        var current = ""
        func flush() {
            if !current.isEmpty, let v = Double(current) {
                tokens.append(.number(CGFloat(v)))
            }
            current = ""
        }
        for ch in d {
            if ch.isLetter {
                flush()
                tokens.append(.command(ch))
            } else if ch == "-" {
                flush()
                current = "-"
            } else if ch == "." {
                if current.contains(".") { flush() }
                current.append(ch)
            } else if ch.isNumber {
                current.append(ch)
            } else {
                flush()
            }
        }
        flush()
        return tokens
    }

    /// SVG arc (endpoint parameterization) → center parameterization → cubic segments of ≤ 90°.
    private static func addArc(_ path: inout Path, from p1: CGPoint, to p2: CGPoint, rx rxIn: CGFloat, ry ryIn: CGFloat,
                               rotationDegrees: CGFloat, largeArc: Bool, sweep: Bool) {
        if p1 == p2 { return }
        var rx = abs(rxIn)
        var ry = abs(ryIn)
        if rx == 0 || ry == 0 {
            path.addLine(to: p2)
            return
        }
        let phi = rotationDegrees * .pi / 180
        let cosPhi = cos(phi)
        let sinPhi = sin(phi)
        let dx = (p1.x - p2.x) / 2
        let dy = (p1.y - p2.y) / 2
        let x1p = cosPhi * dx + sinPhi * dy
        let y1p = -sinPhi * dx + cosPhi * dy
        let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
        if lambda > 1 {
            let s = sqrt(lambda)
            rx *= s
            ry *= s
        }
        let rx2 = rx * rx
        let ry2 = ry * ry
        let numerator = max(0, rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p)
        let denominator = rx2 * y1p * y1p + ry2 * x1p * x1p
        var coefficient = denominator == 0 ? 0 : sqrt(numerator / denominator)
        if largeArc == sweep { coefficient = -coefficient }
        let cxp = coefficient * (rx * y1p / ry)
        let cyp = coefficient * (-(ry * x1p / rx))
        let cx = cosPhi * cxp - sinPhi * cyp + (p1.x + p2.x) / 2
        let cy = sinPhi * cxp + cosPhi * cyp + (p1.y + p2.y) / 2

        func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
            let dot = ux * vx + uy * vy
            let length = sqrt(ux * ux + uy * uy) * sqrt(vx * vx + vy * vy)
            guard length > 0 else { return 0 }
            var a = acos(max(-1, min(1, dot / length)))
            if ux * vy - uy * vx < 0 { a = -a }
            return a
        }
        let theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
        var delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
        if !sweep && delta > 0 {
            delta -= 2 * .pi
        } else if sweep && delta < 0 {
            delta += 2 * .pi
        }

        let segments = max(1, Int(ceil(abs(delta) / (.pi / 2))))
        let step = delta / CGFloat(segments)
        let t = (4.0 / 3.0) * tan(step / 4)
        var theta = theta1
        func map(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            let xr = rx * x
            let yr = ry * y
            return CGPoint(x: cosPhi * xr - sinPhi * yr + cx, y: sinPhi * xr + cosPhi * yr + cy)
        }
        for _ in 0..<segments {
            let cos1 = cos(theta)
            let sin1 = sin(theta)
            let theta2 = theta + step
            let cos2 = cos(theta2)
            let sin2 = sin(theta2)
            let c1 = map(cos1 - t * sin1, sin1 + t * cos1)
            let c2 = map(cos2 + t * sin2, sin2 - t * cos2)
            let end = map(cos2, sin2)
            path.addCurve(to: end, control1: c1, control2: c2)
            theta = theta2
        }
    }
}

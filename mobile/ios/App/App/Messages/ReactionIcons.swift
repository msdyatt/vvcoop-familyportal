import SwiftUI

// The six reactions, drawn for the co-op (app/family-village/messages/reaction-icons.tsx): a flat disc in a brand colour, a cream shape with
// an inked outline, and a gold wash set slightly off-register behind it. The database still stores the same six emoji; this only decides how
// each one is drawn, so every phone shows the same picture. The colours are part of the artwork and do not change with Light and Dark.
// The geometry is the web's, in the same 48 x 48 box.

/// A reaction's name, for VoiceOver (web REACTION_NAMES).
func reactionName(_ emoji: String) -> String {
    switch emoji {
    case "👍": return "Thumbs up"
    case "❤️": return "Heart"
    case "😂": return "Laughing"
    case "🎉": return "Party"
    case "🙏": return "Thank you"
    case "😮": return "Wow"
    default: return emoji
    }
}

struct ReactionIcon: View {
    let emoji: String
    var size: CGFloat = 24

    var body: some View {
        Canvas { context, canvasSize in
            let scale = canvasSize.width / 48
            var drawing = ReactionArt(context: context, scale: scale)
            drawing.draw(emoji)
        }
        .frame(width: size, height: size)
        .accessibilityLabel(reactionName(emoji))
    }
}

private struct ReactionArt {
    var context: GraphicsContext
    let scale: CGFloat

    fileprivate static let ink = Color(red: 0x0B / 255, green: 0x2A / 255, blue: 0x3D / 255)
    private static let cream = Color(red: 0xFA / 255, green: 0xF7 / 255, blue: 0xF1 / 255)
    private static let warm = Color(red: 0xF4 / 255, green: 0xE4 / 255, blue: 0xDC / 255)
    private static let gold = Color(red: 0xF2 / 255, green: 0xC1 / 255, blue: 0x4E / 255)
    private static let red = Color(red: 0xBB / 255, green: 0x61 / 255, blue: 0x41 / 255)

    private static func hex(_ rgb: UInt32) -> Color { Color(red: Double((rgb >> 16) & 0xFF) / 255, green: Double((rgb >> 8) & 0xFF) / 255, blue: Double(rgb & 0xFF) / 255) }

    private static let disc: [String: Color] = ["👍": hex(0x4A6A86), "❤️": red, "😂": hex(0xC28A2C), "🎉": hex(0xA15A64), "🙏": hex(0x637469), "😮": hex(0x3D7479)]

    private static let face = "M24 6a18 18 0 1 0 0 36a18 18 0 1 0 0-36z"

    /// SVG `translate(c) scale(s) translate(-c)` about a point; and the washes' offset version.
    private func about(_ c: CGFloat, _ s: CGFloat, shift: CGFloat = 0) -> CGAffineTransform {
        CGAffineTransform(translationX: c + shift, y: c + shift).scaledBy(x: s, y: s).translatedBy(x: -c, y: -c)
    }

    private var centre: CGAffineTransform { about(24, 0.8) }
    private var wash: CGAffineTransform { about(24, 0.8, shift: 1.6) }

    // MARK: Drawing helpers (everything is in the 48 box; `scale` maps it to points)

    private mutating func fill(_ path: Path, _ transform: CGAffineTransform, _ color: Color, opacity: Double = 1) {
        let mapped = path.applying(transform).applying(CGAffineTransform(scaleX: scale, y: scale))
        context.fill(mapped, with: .color(color.opacity(opacity)))
    }

    private mutating func stroke(_ path: Path, _ transform: CGAffineTransform, width: CGFloat = 1.8, color: Color = ReactionArt.ink) {
        let factor = sqrt(abs(transform.a * transform.d - transform.b * transform.c))
        let mapped = path.applying(transform).applying(CGAffineTransform(scaleX: scale, y: scale))
        context.stroke(mapped, with: .color(color), style: StrokeStyle(lineWidth: width * factor * scale, lineCap: .round, lineJoin: .round))
    }

    private static func svg(_ d: String) -> Path { SVGPath.parse(d) }

    /// A cream shape with its ink outline, and the gold wash behind it.
    private mutating func body(_ paths: [String], inner: (inout ReactionArt) -> Void = { _ in }) {
        let shapes = paths.map(Self.svg)
        for p in shapes { fill(p, wash, Self.gold, opacity: 0.85) }
        for p in shapes { fill(p, centre, Self.cream) }
        for p in shapes { stroke(p, centre) }
        inner(&self)
    }

    private mutating func line(_ d: String) { stroke(Self.svg(d), centre) }

    // MARK: The six

    mutating func draw(_ emoji: String) {
        let circle = Path(ellipseIn: CGRect(x: 0, y: 0, width: 48, height: 48))
        fill(circle, .identity, Self.disc[emoji] ?? Self.red)
        switch emoji {
        case "👍":
            body(["M9 22h7v19H9a2 2 0 0 1-2-2V24a2 2 0 0 1 2-2z", "M18 22l7-14c3.2 0 5.2 2.4 4.2 6l-1.6 6H38a3.5 3.5 0 0 1 3.4 4.4l-3 12A3.5 3.5 0 0 1 35 41H18z"]) { me in
                me.line("M26 31h11"); me.line("M25 36h10")
            }
        case "❤️":
            body(["M24 41C8 30 5.5 19.5 11.5 14c4.2-3.8 9.6-1.8 12.5 3 2.9-4.8 8.3-6.8 12.5-3C42.5 19.5 40 30 24 41z"]) { me in me.line("M13 19q1.5-3 5-3.2") }
        case "😂":
            body([Self.face]) { me in
                me.fill(Self.svg("M14 28h20a10 10 0 0 1-20 0z"), me.centre, ReactionArt.ink)
                me.line("M14.5 20q3-4.5 6.5 0"); me.line("M27 20q3.5-4.5 6.5 0")
            }
        case "🎉":
            body(["M7 42l9-28 18 18z"]) { me in
                me.line("M12 35l7 7"); me.line("M16 24l12 12"); me.line("M22 19q5-8 10-3")
                for d in ["M35 8a2.4 2.4 0 1 0 .1 0z", "M42 20a2 2 0 1 0 .1 0z", "M25 6a2 2 0 1 0 .1 0z", "M37 29l4 1-1 4-4-1z", "M26 17l3-3 3 3-3 3z"] {
                    me.fill(Self.svg(d), me.centre, Self.gold)
                    me.stroke(Self.svg(d), me.centre, width: 1.4)
                }
            }
        case "😮":
            body([Self.face]) { me in
                for d in ["M19 22a2.5 3.5 0 1 0 .1 0z", "M29 22a2.5 3.5 0 1 0 .1 0z", "M24 29a4.5 6 0 1 0 .1 0z"] { me.fill(Self.svg(d), me.centre, ReactionArt.ink) }
                me.line("M14 15q4-3 8-1"); me.line("M26 14q4-2 8 1")
            }
        default: // 🙏: two hands pressed together at a lean, the front thumb out, a cuff on each wrist
            thanks()
        }
    }

    private mutating func thanks() {
        let lean = CGFloat.pi / 180 * 6
        func rotated(_ angle: CGFloat) -> CGAffineTransform { CGAffineTransform(translationX: 24, y: 40).rotated(by: angle).translatedBy(x: -24, y: -40) }
        let left = rotated(lean), right = rotated(-lean)
        let leftHand = Path(roundedRect: CGRect(x: 12.5, y: 4, width: 11.5, height: 31), cornerSize: CGSize(width: 5.6, height: 5.6))
        let rightHand = Path(roundedRect: CGRect(x: 24, y: 4, width: 11.5, height: 31), cornerSize: CGSize(width: 5.6, height: 5.6))
        fill(leftHand, left.concatenating(wash), Self.gold, opacity: 0.85)
        fill(rightHand, right.concatenating(wash), Self.gold, opacity: 0.85)
        let main = about(24, 0.96)
        for (path, t) in [(leftHand, left), (rightHand, right)] {
            fill(path, t.concatenating(main), Self.cream)
            stroke(path, t.concatenating(main))
        }
        let thumb = Self.svg("M33.5 19c5-1.2 8 1.3 7.6 5-.4 3.7-4.3 5.2-8.3 4.4z")
        fill(thumb, main, Self.cream)
        stroke(Self.svg("M33.5 19c5-1.2 8 1.3 7.6 5-.4 3.7-4.3 5.2-8.3 4.4"), main)
        let leftCuff = Path(roundedRect: CGRect(x: 10, y: 36.5, width: 13.5, height: 8), cornerSize: CGSize(width: 2.5, height: 2.5))
        let rightCuff = Path(roundedRect: CGRect(x: 25, y: 36.5, width: 13.5, height: 8), cornerSize: CGSize(width: 2.5, height: 2.5))
        for (path, t) in [(leftCuff, left), (rightCuff, right)] {
            fill(path, t.concatenating(main), Self.warm)
            stroke(path, t.concatenating(main))
        }
        stroke(Self.svg("M18 11v8"), left.concatenating(main))
        stroke(Self.svg("M30 11v8"), right.concatenating(main))
    }
}

// MARK: - SVG path data

/// Just enough of SVG path data (M L H V C S Q A Z, absolute and relative) to draw the reaction shapes.
enum SVGPath {
    static func parse(_ d: String) -> Path {
        var tokens = Tokens(d)
        var path = Path()
        var current = CGPoint.zero, start = CGPoint.zero
        var lastControl: CGPoint?
        var command: Character = "M"
        while let next = tokens.peekCommand() ?? (tokens.hasNumber ? command : nil) {
            if tokens.peekCommand() != nil { tokens.consumeCommand() }
            command = next
            let relative = command.isLowercase
            let base = relative ? current : .zero
            var previousWasCurve = false
            switch command.uppercased() {
            case "M":
                let p = CGPoint(x: tokens.number() + base.x, y: tokens.number() + base.y)
                path.move(to: p); current = p; start = p
                command = relative ? "l" : "L" // further pairs are line-tos
            case "L":
                let p = CGPoint(x: tokens.number() + base.x, y: tokens.number() + base.y)
                path.addLine(to: p); current = p
            case "H":
                let p = CGPoint(x: tokens.number() + (relative ? current.x : 0), y: current.y); path.addLine(to: p); current = p
            case "V":
                let p = CGPoint(x: current.x, y: tokens.number() + (relative ? current.y : 0)); path.addLine(to: p); current = p
            case "C":
                let c1 = CGPoint(x: tokens.number() + base.x, y: tokens.number() + base.y)
                let c2 = CGPoint(x: tokens.number() + base.x, y: tokens.number() + base.y)
                let p = CGPoint(x: tokens.number() + base.x, y: tokens.number() + base.y)
                path.addCurve(to: p, control1: c1, control2: c2); current = p; lastControl = c2; previousWasCurve = true
            case "S":
                let c1 = lastControl.map { CGPoint(x: 2 * current.x - $0.x, y: 2 * current.y - $0.y) } ?? current
                let c2 = CGPoint(x: tokens.number() + base.x, y: tokens.number() + base.y)
                let p = CGPoint(x: tokens.number() + base.x, y: tokens.number() + base.y)
                path.addCurve(to: p, control1: c1, control2: c2); current = p; lastControl = c2; previousWasCurve = true
            case "Q":
                let c = CGPoint(x: tokens.number() + base.x, y: tokens.number() + base.y)
                let p = CGPoint(x: tokens.number() + base.x, y: tokens.number() + base.y)
                path.addQuadCurve(to: p, control: c); current = p
            case "A":
                let rx = tokens.number(), ry = tokens.number(), rotation = tokens.number()
                let large = tokens.flag(), sweep = tokens.flag()
                let p = CGPoint(x: tokens.number() + base.x, y: tokens.number() + base.y)
                addArc(&path, from: current, to: p, rx: rx, ry: ry, rotation: rotation, large: large, sweep: sweep)
                current = p
            case "Z":
                path.closeSubpath(); current = start
            default:
                return path
            }
            if !previousWasCurve { lastControl = nil }
        }
        return path
    }

    /// SVG's endpoint arc, as cubic curves (the standard centre-parameter conversion).
    private static func addArc(_ path: inout Path, from p0: CGPoint, to p1: CGPoint, rx rxIn: CGFloat, ry ryIn: CGFloat, rotation: CGFloat, large: Bool, sweep: Bool) {
        var rx = abs(rxIn), ry = abs(ryIn)
        if rx == 0 || ry == 0 || p0 == p1 { path.addLine(to: p1); return }
        let phi = rotation * .pi / 180
        let cosPhi = cos(phi), sinPhi = sin(phi)
        let dx = (p0.x - p1.x) / 2, dy = (p0.y - p1.y) / 2
        let x1 = cosPhi * dx + sinPhi * dy, y1 = -sinPhi * dx + cosPhi * dy
        let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
        if lambda > 1 { rx *= sqrt(lambda); ry *= sqrt(lambda) }
        let sign: CGFloat = large == sweep ? -1 : 1
        let numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
        let denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1
        let coefficient = sign * sqrt(max(0, numerator / denominator))
        let cxp = coefficient * (rx * y1 / ry), cyp = coefficient * -(ry * x1 / rx)
        let cx = cosPhi * cxp - sinPhi * cyp + (p0.x + p1.x) / 2
        let cy = sinPhi * cxp + cosPhi * cyp + (p0.y + p1.y) / 2
        func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
            let dot = ux * vx + uy * vy, length = sqrt(ux * ux + uy * uy) * sqrt(vx * vx + vy * vy)
            var a = acos(max(-1, min(1, dot / length)))
            if ux * vy - uy * vx < 0 { a = -a }
            return a
        }
        let theta1 = angle(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry)
        var delta = angle((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry)
        if !sweep && delta > 0 { delta -= 2 * .pi } else if sweep && delta < 0 { delta += 2 * .pi }
        let segments = Int(ceil(abs(delta) / (.pi / 2)))
        let step = delta / CGFloat(segments)
        let t = 4 / 3 * tan(step / 4)
        var a = theta1
        for _ in 0..<segments {
            let b = a + step
            func point(_ angle: CGFloat, _ dx: CGFloat = 0, _ dy: CGFloat = 0) -> CGPoint {
                let x = rx * (cos(angle) + dx), y = ry * (sin(angle) + dy)
                return CGPoint(x: cosPhi * x - sinPhi * y + cx, y: sinPhi * x + cosPhi * y + cy)
            }
            path.addCurve(to: point(b), control1: point(a, -t * sin(a), t * cos(a)), control2: point(b, t * sin(b), -t * cos(b)))
            a = b
        }
    }

    private struct Tokens {
        let chars: [Character]
        var index = 0
        init(_ text: String) { chars = Array(text) }

        private mutating func skipSeparators() { while index < chars.count, chars[index] == " " || chars[index] == "," || chars[index] == "\n" { index += 1 } }

        func peekCommand() -> Character? {
            var i = index
            while i < chars.count, chars[i] == " " || chars[i] == "," || chars[i] == "\n" { i += 1 }
            guard i < chars.count, chars[i].isLetter, chars[i] != "e" else { return nil }
            return chars[i]
        }

        mutating func consumeCommand() { skipSeparators(); index += 1 }

        var hasNumber: Bool {
            var i = index
            while i < chars.count, chars[i] == " " || chars[i] == "," || chars[i] == "\n" { i += 1 }
            return i < chars.count && (chars[i].isNumber || chars[i] == "-" || chars[i] == ".")
        }

        /// An arc flag is one digit, and may be written with no separator after it.
        mutating func flag() -> Bool {
            skipSeparators()
            let on = index < chars.count && chars[index] == "1"
            index += 1
            return on
        }

        mutating func number() -> CGFloat {
            skipSeparators()
            var text = ""
            var seenDot = false
            if index < chars.count, chars[index] == "-" || chars[index] == "+" { text.append(chars[index]); index += 1 }
            while index < chars.count {
                let c = chars[index]
                if c.isNumber { text.append(c) }
                else if c == ".", !seenDot { seenDot = true; text.append(c) }
                else { break }
                index += 1
            }
            return CGFloat(Double(text) ?? 0)
        }
    }
}

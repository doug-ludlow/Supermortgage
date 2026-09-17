// Transcribed from docs/prototype/Supermortgage-Agent-Prototype.html (the second <script> block).
// Every string is verbatim. Regenerate rather than edit.

import Foundation

/// `PERMS` in the prototype: what the agent does on its own and what it asks first.
struct Permission: Identifiable, Equatable {
    enum Mode: Equatable { case own, ask }
    let mode: Mode
    let title: String
    let detail: String
    var id: String { title }
}

enum Permissions {
    static let all: [Permission] = [
        Permission(mode: .own, title: "Read your accounts and statements", detail: "Plaid, your servicer, the county"),
        Permission(mode: .own, title: "Get quotes and comps", detail: "Insurance, comps, rate sheets"),
        Permission(mode: .own, title: "File exemptions, refunds and requests", detail: "Anything that only helps you"),
        Permission(mode: .own, title: "Cancel subscriptions that return nothing", detail: "Title lock, home warranties"),
        Permission(mode: .ask, title: "Lock a rate", detail: "Always asks"),
        Permission(mode: .ask, title: "Cancel or switch an insurance policy", detail: "Always asks"),
        Permission(mode: .ask, title: "Sign anything", detail: "Always asks"),
        Permission(mode: .ask, title: "Move money to principal", detail: "Above your buffer"),
        Permission(mode: .ask, title: "Start a refinance", detail: "Asks once per refinance"),
    ]
    static var doesOnItsOwn: [Permission] { all.filter { $0.mode == .own } }
    static var asksFirst: [Permission] { all.filter { $0.mode == .ask } }
}

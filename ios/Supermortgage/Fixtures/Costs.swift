// Transcribed from docs/prototype/Supermortgage-Agent-Prototype.html (the second <script> block).
// Every string is verbatim. Regenerate rather than edit.

import Foundation

/// `COST` in the prototype: the nine lines that make the number.
struct CostLine: Equatable, Identifiable {
    let label: String
    let amount: Double
    var id: String { label }
}

enum Costs {
    static let lines: [CostLine] = [
        CostLine(label: "Mortgage — principal & interest", amount: 1841.06),
        CostLine(label: "Taxes & insurance (escrow)", amount: 571.12),
        CostLine(label: "PMI", amount: 146),
        CostLine(label: "Electricity & gas", amount: 240),
        CostLine(label: "Water, sewer & trash", amount: 128),
        CostLine(label: "Internet", amount: 89),
        CostLine(label: "Pest & lawn service", amount: 99),
        CostLine(label: "Home warranty", amount: 54),
        CostLine(label: "Title lock", amount: 19.99),
    ]

    /// `TOTAL`: the sum of every cost line.
    static var total: Double { lines.reduce(0) { $0 + $1.amount } }
}

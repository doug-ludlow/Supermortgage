// Transcribed from docs/prototype/Supermortgage-Agent-Prototype.html (the second <script> block).
// Every string is verbatim. Regenerate rather than edit.

import Foundation

/// `HOME` in the prototype: the fictional home.
enum Home {
    static let address = "24 Juniper Lane, Sacramento, CA 95816"
    static let owner = "Doug"
    static let value: Double = 410000
    static let balance: Double = 287400
    static let rate: Double = 6.125
    static let principalAndInterest: Double = 1841.06
    static let escrow: Double = 571.12
    static let pmi: Double = 146
    static let ltv: Double = 70
    static let payment: Double = 2412.18
    static let assessed: Double = 392000
    static let renewal = "March 3"
}

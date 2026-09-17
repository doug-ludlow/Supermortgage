import Foundation

/// `money`, `clock` and `dayLabel` from the prototype.
enum Format {
    private static let enUS = Locale(identifier: "en_US")

    /// `money(v, d)`: US currency with exactly `digits` fraction digits, rounding half away from zero.
    static func money(_ value: Double, _ digits: Int = 0) -> String {
        let f = NumberFormatter()
        f.locale = enUS
        f.numberStyle = .currency
        f.currencyCode = "USD"
        f.maximumFractionDigits = digits
        f.minimumFractionDigits = digits
        f.roundingMode = .halfUp
        return f.string(from: NSNumber(value: value)) ?? "$\(value)"
    }

    /// `clock()`: the current time as "9:41 AM".
    static func clock(_ date: Date = Date()) -> String {
        date.formatted(Date.FormatStyle(date: .omitted, time: .shortened).locale(enUS))
            .replacingOccurrences(of: "\u{202F}", with: " ")
    }

    /// `dayLabel()`: "{Weekday} morning|afternoon|evening" — before noon, before 17:00, after.
    static func dayLabel(_ date: Date = Date(), calendar: Calendar = .current) -> String {
        let weekday = date.formatted(Date.FormatStyle().weekday(.wide).locale(enUS))
        let hour = calendar.component(.hour, from: date)
        let part = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening"
        return "\(weekday) \(part)"
    }

    /// The Work row amount: "−$146" + "/mo est.", "+$412" + "once", or nothing when 0.
    static func amount(for item: WorkItem) -> (main: String, small: String)? {
        if let once = item.once {
            return ("+\(money(once))", "once")
        }
        if item.dollarsPerMonth != 0 {
            let sign = item.dollarsPerMonth < 0 ? "−" : "+"
            let estimated = item.status == .needsYou || item.status == .waiting || item.status == .needsConnection
            return ("\(sign)\(money(abs(item.dollarsPerMonth)))", "/mo" + (estimated ? " est." : ""))
        }
        return nil
    }

    /// The Work sheet's Worth row: "$412 once" or "$146 a month"; nil when the row is worth nothing yet.
    static func worth(for item: WorkItem) -> String? {
        if let once = item.once { return "\(money(once)) once" }
        if item.dollarsPerMonth != 0 { return "\(money(abs(item.dollarsPerMonth))) a month" }
        return nil
    }
}

extension String {
    /// Case-insensitive regular-expression test, the prototype's `/…/i.test(q)`.
    func matches(_ pattern: String) -> Bool {
        range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
    }

    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}

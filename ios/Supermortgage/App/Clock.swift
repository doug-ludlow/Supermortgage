import Foundation

/// The clock the chat script and every delayed action sleep on. Injected so tests run with no delay.
protocol AppClock {
    func sleep(ms: Int) async throws
}

struct RealClock: AppClock {
    func sleep(ms: Int) async throws {
        try await Task.sleep(nanoseconds: UInt64(max(0, ms)) * 1_000_000)
    }
}

/// Returns at once (after checking for cancellation), so a whole script runs in a test in one go.
struct ImmediateClock: AppClock {
    func sleep(ms: Int) async throws {
        try Task.checkCancellation()
        await Task.yield()
    }
}

import Foundation
import Combine

/// Owns which sheet is up, the Refinance cover and the toast. Only one sheet at a time;
/// presenting another replaces it, exactly as the prototype's single `<dialog>` does.
@MainActor
final class Router: ObservableObject {
    @Published var sheet: SheetKind?
    @Published var refinanceShown = false
    @Published var toastText: String?

    private var toastTask: Task<Void, Never>?
    private let clock: AppClock
    /// False in unit tests, where the last toast must stay readable.
    private let autoClearsToasts: Bool

    init(clock: AppClock = RealClock(), autoClearsToasts: Bool = true) {
        self.clock = clock
        self.autoClearsToasts = autoClearsToasts
    }

    func present(_ kind: SheetKind) {
        sheet = kind
    }

    func dismiss() {
        sheet = nil
    }

    /// The dark pill at the bottom, 2.2s.
    func toast(_ text: String) {
        toastText = text
        toastTask?.cancel()
        guard autoClearsToasts else { return }
        toastTask = Task { [weak self] in
            guard let self else { return }
            do { try await self.clock.sleep(ms: 2200) } catch { return }
            if !Task.isCancelled { self.toastText = nil }
        }
    }

    func reset() {
        toastTask?.cancel()
        toastTask = nil
        sheet = nil
        refinanceShown = false
        toastText = nil
    }
}

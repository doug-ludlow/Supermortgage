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

    init(clock: AppClock = RealClock()) {
        self.clock = clock
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

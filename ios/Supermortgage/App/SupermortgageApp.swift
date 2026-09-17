import SwiftUI

@main
struct SupermortgageApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .environmentObject(model.router)
        }
    }
}

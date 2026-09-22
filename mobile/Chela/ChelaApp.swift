import SwiftUI

/// Claw: the OpenClaw Control UI, as an app.
///
/// The app is a shell around one web view, so the scene holds nothing but the
/// view the shell lives in. Everything that grows from here (the loading
/// surface, notices, the gateway picker) hangs off `ContentView`, because this
/// scene owns a window and nothing else.
@main
struct ChelaApp: App {
    init() {
        #if DEBUG
        // A debug run may be launched pointed at a gateway with a token in the
        // environment, so a simulator can prove a real authenticated connection.
        // Inert without both, and compiled out of a release build. See
        // GatewayStore.seedDebugTokenFromEnvironment.
        GatewayStore.seedDebugTokenFromEnvironment()
        #endif
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

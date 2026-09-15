import SwiftUI

/// Claw: the OpenClaw Control UI, as an app.
///
/// The app is a shell around one web view, so the scene holds nothing but the
/// view the shell lives in. Everything that grows from here (the loading
/// surface, notices, the gateway picker) hangs off `ContentView`, because this
/// scene owns a window and nothing else.
@main
struct ClawApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

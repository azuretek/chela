import SwiftUI

/// The whole app: the Control UI, full screen and nothing else.
///
/// No navigation bar and no tab bar, because the Control UI is the interface
/// and a second set of controls drawn around it would be a second owner of the
/// same job. What is native here is only what has to be: the web view's host,
/// and later the loading and failure surfaces, which are overlays *over* the
/// page rather than chrome beside it.
struct ContentView: View {
    var body: some View {
        WebView(url: Gateway.default.url)
            // Edge to edge. The Control UI paints its own background over the
            // full window on the desktop, so stopping at the safe area would
            // leave a band of window colour above and below it and make the
            // phone look like a different app. The web view still insets its
            // own content (see `WebView`), so nothing ends up under the status
            // bar or the home indicator.
            .ignoresSafeArea()
    }
}

#Preview {
    ContentView()
}

import SwiftUI

/// The one thing this client cannot derive: which gateway to load.
///
/// Shown on first run, because there is no compiled-in address to start from and
/// none is wanted, and shown again when a load fails and someone takes the
/// connection notice's **Open Settings** action. That second route is what makes
/// a mistyped or changed address recoverable, and it is why this view is a
/// surface rather than a one-shot onboarding step.
///
/// Phase 6 replaces this with a list and a picker, which is why nothing here
/// knows about more than one gateway.
///
/// Deliberately native-only UI: the notice card mirrors the desktop's own card
/// and reads its colours from the shared tokens, but this screen has no desktop
/// counterpart, so it uses the system's own colours rather than inventing a
/// second consumer of the token spec.
struct GatewaySetupView: View {
    let store: GatewayStore

    /// How someone who already has a gateway gets back to the page. Nil while
    /// there is nothing to go back to, which is the first-run case.
    let onDismiss: (() -> Void)?

    @State private var entered: String
    @State private var refused = false

    init(store: GatewayStore, onDismiss: (() -> Void)? = nil) {
        self.store = store
        self.onDismiss = onDismiss
        _entered = State(initialValue: store.gateway?.url.absoluteString ?? "")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(Naming.product)
                .font(.largeTitle.bold())

            Text("Which gateway should this app load?")
                .font(.headline)

            // The address is asked for here because it is nowhere else: it is
            // not in the app and not in the build, so this device is where it
            // comes from.
            Text("The address is kept on this device. A Tailscale Serve address is the usual one, and it loads without a certificate prompt.")
                .font(.callout)
                .foregroundStyle(.secondary)

            TextField("your-host.your-tailnet.ts.net", text: $entered)
                .textFieldStyle(.roundedBorder)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
                .submitLabel(.go)
                .onSubmit(connect)
                .accessibilityLabel("Gateway address")

            if refused {
                Text("That is not an address this app can load. Use a host name, or a full http or https URL.")
                    .font(.footnote)
                    .foregroundStyle(.red)
            }

            Button("Connect", action: connect)
                .buttonStyle(.borderedProminent)
                .disabled(entered.trimmingCharacters(in: .whitespaces).isEmpty)

            if let onDismiss, store.gateway != nil {
                Button("Back", action: onDismiss)
            }

            Spacer()
        }
        .padding()
    }

    private func connect() {
        refused = !store.save(entered)
    }
}

#Preview {
    GatewaySetupView(store: GatewayStore())
}

import SwiftUI
import UIKit

/// The device-pairing screen, shown when the gateway refuses this device until an
/// operator approves it.
///
/// It is full screen rather than a banner, because the condition it describes is
/// not "the page is broken and you can still reach settings": the gateway has
/// held the socket, so there is no Control UI behind it to draw over, and the one
/// thing to do is approve the device on the gateway host. The screen says that in
/// plain language, shows the identifying detail the operator matches (the request
/// id, and the device this build reports), and states that this device cannot
/// approve itself.
///
/// Everything it says is read from `Pairing.copy`, which comes from the shared
/// `core/spec/pairing.json`, so the wording is one owner shared with a later
/// Android client rather than a string per platform. The command shown is the
/// real instruction the gateway and the Control UI give: `openclaw devices
/// approve <requestId>`, or the `--latest` form when the refusal carried no id.
///
/// It draws nothing about recovery beyond the waiting line, on purpose: recovery
/// is automatic. The web view keeps retrying underneath, and the moment the
/// gateway socket opens `PairingState` moves to authenticated and this screen is
/// replaced by the page. There is no button here that the user must press to get
/// back, because pressing one was the silent-failure this screen exists to end.
struct PairingView: View {
    @ObservedObject var state: PairingState

    /// The device this build reports, shown so the operator can tell which pending
    /// request is this one when several devices are waiting. The same hardware
    /// identifier the client-context block uses, which names a model rather than a
    /// person and is what the kernel reports.
    let deviceLabel: String

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let copy = Pairing.copy
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header(copy)

                Text(copy.body)
                    .font(.system(size: 15))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                // The one requirement sentence for this refusal, which differs
                // between a first connection and an upgrade.
                Text(state.requirement)
                    .font(.system(size: 15, weight: .medium))
                    .fixedSize(horizontal: false, vertical: true)

                commandCard(copy)

                identity(copy)

                waiting(copy)

                Spacer(minLength: 0)
            }
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Color(uiColor: .systemBackground))
        .accessibilityElement(children: .contain)
    }

    private func header(_ copy: Pairing.Copy) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "lock.shield")
                .font(.system(size: 30, weight: .regular))
                .foregroundStyle(.tint)
                .accessibilityHidden(true)
            Text(copy.title)
                .font(.system(size: 24, weight: .bold))
        }
        .padding(.top, 8)
    }

    /// The command to run, in a monospaced card with a copy button. A card rather
    /// than inline text because it is the one thing on this screen a person acts
    /// on, and it has to be selectable and unambiguous: a wrapped shell command in
    /// body text is a transcription error waiting to happen.
    private func commandCard(_ copy: Pairing.Copy) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(copy.commandLabel)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.secondary)
            HStack(alignment: .top, spacing: 12) {
                Text(state.approveCommand)
                    .font(.system(size: 14, design: .monospaced))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button {
                    UIPasteboard.general.string = state.approveCommand
                } label: {
                    Image(systemName: "doc.on.doc")
                        .font(.system(size: 15))
                        .accessibilityLabel("Copy command")
                }
                .buttonStyle(.plain)
                .foregroundStyle(.tint)
            }
            .padding(12)
            .background(Color(uiColor: .secondarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

            Text(copy.cannotRunHere)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
        }
    }

    /// The identifying detail the operator matches: the request id if the refusal
    /// carried one, and the device this build reports. Laid out as labelled rows
    /// so a person reading a `openclaw devices list` on the host can line them up.
    @ViewBuilder
    private func identity(_ copy: Pairing.Copy) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let requestId = state.refusal?.requestId {
                identityRow(label: copy.requestIdLabel, value: requestId)
            }
            identityRow(label: copy.deviceIdLabel, value: deviceLabel)
        }
        .padding(.top, 4)
    }

    private func identityRow(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.system(size: 14, design: .monospaced))
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The waiting line, with the same spinner shape the Control UI's own pairing
    /// screen uses, so the two read as the same state. It is a statement of fact,
    /// not a control: the screen clears itself.
    private func waiting(_ copy: Pairing.Copy) -> some View {
        HStack(spacing: 10) {
            ProgressView()
                .controlSize(.small)
            Text(copy.waiting)
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, 8)
        .accessibilityElement(children: .combine)
    }
}

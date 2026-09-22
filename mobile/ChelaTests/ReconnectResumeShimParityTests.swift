import XCTest

@testable import Chela

/// Parity with `core/spec/reconnect-resume-shim.json`, the ONE owner of the
/// reserved reconnect-resume property and of the injected script that drops it
/// from a `chat.send` frame.
///
/// The same shape as `AppSettingsAffordanceParityTests`, and for the same
/// reason: this client has no Swift version of the script at all. It reads the
/// spec out of its own bundle and installs those bytes through a `WKUserScript`,
/// so what is asserted here is that what the app will actually install is the file
/// `core/reconnect-resume-shim.js` hands any other client, line for line and byte
/// for byte.
final class ReconnectResumeShimParityTests: XCTestCase {
    private struct SpecOnly: Decodable {
        let reservedProperty: String
        let method: String
        let global: String
        let hook: [String]
        let why: [String]
    }

    /// The spec as it is on disk in the repo, which is the JS module's source too.
    private func repoSpecData() throws -> Data {
        let url = try Fixtures.spec().appendingPathComponent("reconnect-resume-shim.json")
        return try Data(contentsOf: url)
    }

    private func repoSpec() throws -> SpecOnly {
        try JSONDecoder().decode(SpecOnly.self, from: repoSpecData())
    }

    // MARK: - The one copy of the script

    func testTheInstalledScriptIsTheFileTheOtherClientsRead() throws {
        let spec = try repoSpec()
        let expected = spec.hook.joined(separator: "\n")

        XCTAssertFalse(expected.isEmpty, "the spec's hook is empty, so this test would prove nothing")
        XCTAssertEqual(
            ReconnectResumeShim.script,
            expected,
            "the script this app installs is not the script core/spec/reconnect-resume-shim.json owns"
        )
        XCTAssertEqual(ReconnectResumeShim.reservedProperty, spec.reservedProperty)
        XCTAssertEqual(ReconnectResumeShim.method, spec.method)
        XCTAssertEqual(ReconnectResumeShim.global, spec.global)

        // The bundle carries that same file rather than a second one: an app
        // cannot read the repo, so the bundled copy is what ships, and a stale
        // copy would be a second owner.
        let bundled = try XCTUnwrap(
            Bundle.main.url(forResource: "reconnect-resume-shim", withExtension: "json"),
            "the app did not bundle core/spec/reconnect-resume-shim.json, so it cannot install the shim"
        )
        XCTAssertEqual(try Data(contentsOf: bundled), try repoSpecData(), "the bundled spec has diverged from the repo's")
    }

    func testTheScriptWatchesThePropertyTheGatewayRefuses() throws {
        let spec = try repoSpec()
        // Pinned as literals so a rename of the spec value fails here rather than
        // in the field: the property is the page's, and the method is the wire's.
        // The first is what requestChatSend sets on a resumed `chat.send` in the
        // OpenClaw checkout (ui/src/pages/chat/chat-send-request.ts); the second
        // is the method the gateway's validation rejects it on when its strip does
        // not run for this client.
        XCTAssertEqual(spec.reservedProperty, "__controlUiReconnectResume")
        XCTAssertEqual(spec.method, "chat.send")

        // And the script the app ships is watching that same name, rather than a
        // literal that drifted away from the spec it is supposed to read.
        XCTAssertTrue(
            ReconnectResumeShim.script.contains(spec.reservedProperty),
            "the installed script does not name the reserved property the spec owns"
        )
        XCTAssertTrue(
            ReconnectResumeShim.script.contains(spec.method),
            "the installed script does not name the method the spec owns"
        )
    }

    func testTheScriptLeavesEveryFrameItDoesNotRecogniseAlone() throws {
        let script = ReconnectResumeShim.script
        // The two halves of that promise, both of which a rewrite would drop: the
        // envelope test that decides whether a frame is the one, and the catch
        // that falls through to the original send rather than throwing inside a
        // page we do not own.
        XCTAssertTrue(script.contains("typeof data !== 'string'"), "the script no longer checks what it was handed")
        XCTAssertTrue(script.contains("try {"), "the wrapper has no catch, so a bad frame would throw in the page")
        XCTAssertTrue(script.contains("catch (error) {}"), "the wrapper no longer falls through on a bad frame")
        XCTAssertTrue(script.contains("send.call(this, data)"), "the original send is not called with the socket as its receiver")
        XCTAssertTrue(script.contains("hasOwnProperty"), "the property test no longer checks presence on the params object")
    }

    func testTheSharedScriptCarriesNothingFromThisClient() throws {
        // If this client's own name or engine were in the script, the two clients
        // could not run the same bytes and this arrangement is a fiction.
        let script = ReconnectResumeShim.script
        for foreign in [Naming.mobileToken, "chela-desktop", "UIKit", "WKUserScript", "webkit.messageHandlers", "postMessage", "localStorage"] {
            XCTAssertFalse(script.contains(foreign), "\(foreign) does not belong in the shared script")
        }
    }

    // MARK: - The shim actually reaches the page

    /// Read from the source rather than from a live web view, the same way
    /// `AppSettingsAffordanceParityTests` reads `ContentView.swift`: the claim is
    /// about what this client INSTALLS, and a spec read at runtime with no
    /// `WKUserScript` behind it is a fix that never reaches the page.
    func testTheShimIsInstalledAtDocumentStart() throws {
        let webView = try String(
            contentsOf: try Fixtures.root().appendingPathComponent("mobile").appendingPathComponent("Chela").appendingPathComponent("WebView.swift"),
            encoding: .utf8
        )
        let installation = """
        source: ReconnectResumeShim.script,
                    injectionTime: .atDocumentStart,
        """
        XCTAssertTrue(
            webView.contains(installation),
            "WebView does not install ReconnectResumeShim.script at document start, so the page's send is never wrapped"
        )
    }

    // MARK: - What retires it

    func testTheSpecNamesTheTriggerThatRetiresTheShim() throws {
        // A shim with no named removal trigger becomes permanent by default, so
        // the trigger is asserted rather than trusted to survive the next edit.
        let why = try repoSpec().why.joined(separator: "\n")
        XCTAssertTrue(why.contains("REMOVAL TRIGGER"), "the spec no longer names what retires the shim")
        XCTAssertTrue(
            why.contains("strips the reserved field for every client"),
            "the trigger no longer names the upstream condition, so nothing says when the shim may go"
        )
    }
}

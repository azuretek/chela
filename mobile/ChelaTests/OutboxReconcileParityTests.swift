import XCTest

@testable import Chela

/// Parity with `core/spec/outbox-reconcile.json`, the ONE owner of the injected
/// script that settles a queued message the Control UI leaves stuck on a live
/// connection.
///
/// The same shape as `ReconnectResumeShimParityTests`: this client has no Swift
/// version of the script. It reads the spec out of its own bundle and installs
/// those bytes through a `WKUserScript`, so what is asserted here is that what the
/// app installs is the file `core/outbox-reconcile.js` hands the desktop.
final class OutboxReconcileParityTests: XCTestCase {
    private struct SpecOnly: Decodable {
        let global: String
        let hook: [String]
        let why: [String]
    }

    private func repoSpecData() throws -> Data {
        let url = try Fixtures.spec().appendingPathComponent("outbox-reconcile.json")
        return try Data(contentsOf: url)
    }

    private func repoSpec() throws -> SpecOnly {
        try JSONDecoder().decode(SpecOnly.self, from: repoSpecData())
    }

    func testTheInstalledScriptIsTheFileTheDesktopReads() throws {
        let spec = try repoSpec()
        let expected = spec.hook.joined(separator: "\n")
        XCTAssertFalse(expected.isEmpty, "the spec's hook is empty, so this test would prove nothing")
        XCTAssertEqual(OutboxReconcile.script, expected, "the script this app installs is not the one core/spec/outbox-reconcile.json owns")
        XCTAssertEqual(OutboxReconcile.global, spec.global)
        let bundled = try XCTUnwrap(
            Bundle.main.url(forResource: "outbox-reconcile", withExtension: "json"),
            "the app did not bundle core/spec/outbox-reconcile.json, so it cannot install the reconcile"
        )
        XCTAssertEqual(try Data(contentsOf: bundled), try repoSpecData(), "the bundled spec has diverged from the repo's")
    }

    func testTheSharedScriptCarriesNothingFromThisClient() throws {
        let script = OutboxReconcile.script
        for foreign in [Naming.mobileToken, "chela-desktop", "UIKit", "WKUserScript", "webkit.messageHandlers", "postMessage", "localStorage"] {
            XCTAssertFalse(script.contains(foreign), "\(foreign) does not belong in the shared script")
        }
    }

    /// Read from the source rather than a live web view: the claim is about what
    /// this client INSTALLS, and a spec read with no `WKUserScript` behind it is a
    /// fix that never reaches the page.
    func testTheReconcileIsInstalledAtDocumentStart() throws {
        let webView = try String(
            contentsOf: try Fixtures.root().appendingPathComponent("mobile").appendingPathComponent("Chela").appendingPathComponent("WebView.swift"),
            encoding: .utf8
        )
        let installation = """
        source: OutboxReconcile.script,
                    injectionTime: .atDocumentStart,
        """
        XCTAssertTrue(webView.contains(installation), "WebView does not install OutboxReconcile.script at document start")
    }

    func testTheSpecNamesTheTriggerThatRetiresIt() throws {
        let why = try repoSpec().why.joined(separator: "\n")
        XCTAssertTrue(why.contains("REMOVAL TRIGGER"), "the spec no longer names what retires the reconcile")
    }
}

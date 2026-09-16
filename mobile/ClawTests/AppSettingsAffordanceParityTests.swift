import XCTest

@testable import Claw

/// Parity with `core/spec/app-settings-affordance.json`, the ONE owner of the
/// injected script that adds the "App settings" control to the Control UI's
/// footer.
///
/// The same shape as `PromptMetadataParityTests`, and for the same reason: this
/// client has no Swift version of the script at all. It reads the spec out of its
/// own bundle and installs those bytes through a `WKUserScript`, so what is
/// asserted here is that what the app will actually install is the file the
/// desktop reads, line for line and byte for byte, plus the one thing that is
/// this client's own: the bridge shim that lets the script reach the settings
/// sheet through a message handler rather than an IPC.
final class AppSettingsAffordanceParityTests: XCTestCase {
    private struct SpecOnly: Decodable {
        let global: String
        let configGlobal: String
        let marker: String
        let anchors: [String: String]
        let script: [String]
    }

    /// The spec as it is on disk in the repo, which is the desktop's source too.
    private func repoSpecData() throws -> Data {
        let url = try Fixtures.spec().appendingPathComponent("app-settings-affordance.json")
        return try Data(contentsOf: url)
    }

    private func repoSpec() throws -> SpecOnly {
        try JSONDecoder().decode(SpecOnly.self, from: repoSpecData())
    }

    // MARK: - The one copy of the script

    func testTheInstalledScriptIsTheFileTheDesktopReads() throws {
        let spec = try repoSpec()
        let expected = spec.script.joined(separator: "\n")

        XCTAssertFalse(expected.isEmpty, "the spec's script is empty, so this test would prove nothing")
        XCTAssertEqual(
            AppSettingsAffordance.script,
            expected,
            "the script this app installs is not the script core/spec/app-settings-affordance.json owns"
        )
        XCTAssertEqual(AppSettingsAffordance.global, spec.global)
        XCTAssertEqual(AppSettingsAffordance.configGlobal, spec.configGlobal)
        XCTAssertEqual(AppSettingsAffordance.marker, spec.marker)

        // The bundle carries that same file rather than a second one: an app
        // cannot read the repo, so the bundled copy is what ships, and a stale
        // copy would be a second owner.
        let bundled = try XCTUnwrap(
            Bundle.main.url(forResource: "app-settings-affordance", withExtension: "json"),
            "the app did not bundle core/spec/app-settings-affordance.json, so it cannot install the shared script"
        )
        XCTAssertEqual(try Data(contentsOf: bundled), try repoSpecData(), "the bundled spec has diverged from the repo's")
    }

    func testTheScriptCarriesNothingPlatformSpecific() throws {
        let script = AppSettingsAffordance.script
        // If either client's own name or engine were in the script, the two
        // clients could not run the same bytes and this arrangement is a fiction.
        for platform in [Naming.mobileToken, "claw-desktop", "UIKit", "WKUserScript", "ipcRenderer", "webkit.messageHandlers"] {
            XCTAssertFalse(script.contains(platform), "\(platform) does not belong in the shared script")
        }
    }

    // MARK: - This client's own half: the bridge shim

    func testTheInstallationIsTheBridgeThenTheConfigThenTheScript() throws {
        let installation = AppSettingsAffordance.installation()

        // The bridge is installed on its own global, and the config on a separate
        // plain global the script reads. The two are kept apart so this client
        // installs the SAME shared script the desktop does, which reads a frozen
        // bridge and must never write it.
        XCTAssertTrue(
            installation.contains("window.\(AppSettingsAffordance.global) = {"),
            "the installation sets the bridge global"
        )
        XCTAssertTrue(
            installation.contains("window.\(AppSettingsAffordance.configGlobal) = {"),
            "the installation sets the config global"
        )
        // The label and tooltip reach the page.
        XCTAssertTrue(installation.contains("App settings"), "the label is carried into the page")
        XCTAssertTrue(installation.contains("\(Naming.product) settings"), "the tooltip names this product")
        // The bridge shim posts to THIS client's message handler, which is the
        // one part that differs from the desktop. open() takes no argument.
        XCTAssertTrue(
            installation.contains("window.webkit.messageHandlers.\(AppSettingsBridge.messageName).postMessage"),
            "the iOS bridge posts to its message handler"
        )
        // The shared script is installed unchanged, at the end.
        XCTAssertTrue(installation.hasSuffix(AppSettingsAffordance.script), "the shared script is installed verbatim")
    }

    // MARK: - The bridge relays exactly one ask

    @MainActor
    func testTheBridgeRelaysTheOpenAsk() {
        var opened = 0
        let bridge = AppSettingsBridge(onOpen: { opened += 1 })
        // A message under the right name opens settings.
        bridge.userContentController(WKUserContentControllerStub(), didReceive: MessageStub(name: AppSettingsBridge.messageName))
        XCTAssertEqual(opened, 1, "a posted open() raised the sheet")
        // A message under any other name is ignored, so a stray post cannot open it.
        bridge.userContentController(WKUserContentControllerStub(), didReceive: MessageStub(name: "somethingElse"))
        XCTAssertEqual(opened, 1, "only the affordance's own message opens settings")
    }
}

// MARK: - WebKit stubs

import WebKit

/// A `WKScriptMessage` whose name is settable, since the real one's is read-only.
private final class MessageStub: WKScriptMessage {
    private let stubName: String
    init(name: String) { self.stubName = name; super.init() }
    override var name: String { stubName }
    override var body: Any { [:] }
}

/// The handler ignores its controller argument, so an empty one is enough.
private final class WKUserContentControllerStub: WKUserContentController {}

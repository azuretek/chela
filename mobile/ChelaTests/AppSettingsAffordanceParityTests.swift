import XCTest

@testable@testable import Chela

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
        struct Handoff: Decodable {
            let readyTimeoutMs: Int
            let pollMs: Int
        }

        let global: String
        let configGlobal: String
        let marker: String
        let anchors: [String: String]
        let routes: [String: String]?
        let handoff: Handoff
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
        for platform in [Naming.mobileToken, "chela-desktop", "UIKit", "WKUserScript", "ipcRenderer", "webkit.messageHandlers"] {
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

    // MARK: - The readiness question, which is what makes the handoff atomic

    /// A Swift string as the JavaScript literal the statements splice in. The same
    /// three lines the app's own `jsonString` uses, and deliberately so: the
    /// assertion is that the values came FROM THE SPEC, and comparing against the
    /// same encoding is what makes that checkable without a JavaScript engine.
    private func jsonString(_ value: String) throws -> String {
        String(data: try JSONEncoder().encode(value), encoding: .utf8) ?? "\"\""
    }

    func testTheReadinessQuestionAsksAboutTheSpecsOwnSurfaceAndRoute() throws {
        let spec = try repoSpec()
        let surface = try XCTUnwrap(spec.anchors["controlUiSettingsSurface"],
            "the spec names no surface, so nothing can prove the destination arrived")
        let route = try XCTUnwrap(spec.routes?["appearance"], "the spec names no destination route")
        let source = try XCTUnwrap(AppSettingsAffordance.controlUiSettingsReadySource(),
            "this build cannot build the readiness question, so the handoff would reveal onto a load")

        // Built from the spec rather than from a selector written into this client,
        // so a Control UI change is one edit in the one owner both clients read.
        XCTAssertTrue(source.contains(try jsonString(surface)),
            "the readiness question does not look for the surface the spec names")
        XCTAssertTrue(source.contains(try jsonString(route)),
            "the readiness question does not require the route the spec names")
    }

    func testTheReadinessQuestionNeedsBothTheRouteAndThePaintedNode() throws {
        let source = try XCTUnwrap(AppSettingsAffordance.controlUiSettingsReadySource())
        // Both halves are load-bearing and neither is decorative: the route is what
        // makes it the page the reader asked for, and the box is what makes it
        // rendered rather than merely committed.
        XCTAssertTrue(source.contains("location.pathname"), "the route half is gone")
        XCTAssertTrue(source.contains("getBoundingClientRect"), "the painted half is gone")
        XCTAssertTrue(source.contains("width > 0"), "a zero-width node would count as painted")
        XCTAssertTrue(source.contains("catch"), "a question that throws has nowhere to fail soft to")
    }

    func testTheHandoffTimingIsTheSpecsSoBothClientsHoldTheSameLine() throws {
        let spec = try repoSpec()
        XCTAssertGreaterThan(spec.handoff.readyTimeoutMs, spec.handoff.pollMs,
            "the deadline is not longer than one interval, so the wait would never ask twice")
        XCTAssertGreaterThanOrEqual(spec.handoff.readyTimeoutMs, 3000,
            "the deadline is too short to cover the destination's own load")
        XCTAssertEqual(AppSettingsAffordance.readyTimeoutMs, spec.handoff.readyTimeoutMs)
        XCTAssertEqual(AppSettingsAffordance.pollMs, spec.handoff.pollMs)
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

    // MARK: - The phone's ONE settings entry

    /// The injected affordance is this client's ONLY way into settings.
    ///
    /// It used to be one of two. A native `SettingsButton` was drawn as an
    /// `overlay(alignment: .topTrailing)` over the Control UI, so the phone showed
    /// a second settings control at the top right beside the shared one in the
    /// footer, and that duplicate was reported and removed. What this asserts is
    /// the arrangement that replaced it rather than the deletion by itself: the
    /// bridge below is the only thing that raises the sheet, and no source in the
    /// app draws a settings control of its own.
    ///
    /// Read from the sources rather than from a view tree, for the reason
    /// `SettingsSpecTests` reads `SettingsHost.swift`: the claim is about what
    /// this client CONTAINS, and rendering the tree would need a host app.
    func testTheInjectedAffordanceIsTheOnlySettingsEntryOnThisClient() throws {
        let contentView = try readAppSource("ContentView.swift")
        XCTAssertTrue(
            contentView.contains("onOpenAppSettings: { showingSettings = true }"),
            "ContentView does not wire the affordance's bridge to the settings sheet, so nothing would open it"
        )

        // The removed control, by the two names that would bring it back: the
        // view type and the symbol it drew. Either one in any app source means the
        // phone has a second entry point again.
        for name in try appSourceNames() {
            let source = try readAppSource(name)
            XCTAssertFalse(
                source.contains("SettingsButton"),
                "\(name) still declares or draws a settings button, so the phone has a second settings entry"
            )
            XCTAssertFalse(
                source.contains("slider.horizontal.3"),
                "\(name) still draws the settings symbol the corner control used, so a second entry is back"
            )
        }
    }

    // MARK: - Reading this client's own sources

    /// Every Swift source shipped in the app, by file name.
    private func appSourceNames() throws -> [String] {
        try FileManager.default
            .contentsOfDirectory(atPath: try appSourceDirectory().path)
            .filter { $0.hasSuffix(".swift") }
    }

    private func readAppSource(_ name: String) throws -> String {
        try String(contentsOf: try appSourceDirectory().appendingPathComponent(name), encoding: .utf8)
    }

    private func appSourceDirectory() throws -> URL {
        try Fixtures.root().appendingPathComponent("mobile").appendingPathComponent("Chela")
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

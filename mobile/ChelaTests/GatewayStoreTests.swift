import XCTest

@testable import Claw

/// The client's own gateway configuration.
///
/// Worth pinning because there is no second copy of this knowledge anywhere: no
/// address is compiled into the app and none arrives from the build, so this store
/// is the only thing that decides what the app loads. What counts as an address
/// someone can type, what the list does when a row is edited or removed, and that
/// a stored list survives a relaunch are what a mistake here would take away.
///
/// The RULES the list follows are `ConfigModel`'s and are pinned against the shared
/// fixture in `ConfigModelParityTests`. What is tested here is this file's own part:
/// where the bytes live, and what happens to an install that predates the list.
final class GatewayStoreTests: XCTestCase {
    private var suiteName = ""
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        // A suite of its own rather than `.standard`, so a test run can neither
        // see nor leave anything the app would.
        suiteName = "claw.tests.gateway.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    /// A store over this test's own defaults. A second call is what a relaunch is.
    private func store() -> GatewayStore {
        GatewayStore(defaults: defaults, key: "gateway", legacyKey: "legacy")
    }

    // MARK: - What counts as an address

    func testABareHostGetsHTTPSBecauseThatIsWhatAPhoneKeyboardTypes() {
        let gateway = Gateway.parse("gateway.example.com")
        XCTAssertEqual(gateway?.url.absoluteString, "https://gateway.example.com")
        XCTAssertEqual(gateway?.label, "gateway.example.com")
    }

    func testAFullURLIsKeptAsTyped() {
        XCTAssertEqual(
            Gateway.parse("http://127.0.0.1:18789")?.url.absoluteString,
            "http://127.0.0.1:18789",
            "the gateway's own listener and a loopback address both answer over http"
        )
        XCTAssertEqual(
            Gateway.parse("https://gateway.example.com:8443/ui")?.url.absoluteString,
            "https://gateway.example.com:8443/ui"
        )
    }

    func testSurroundingSpaceFromAPasteIsForgiven() {
        XCTAssertEqual(
            Gateway.parse("  gateway.example.com  ")?.url.absoluteString,
            "https://gateway.example.com"
        )
    }

    func testTheLabelStartsAsTheHostSoTwoGatewaysOnOneTailnetReadApart() {
        XCTAssertEqual(Gateway.parse("https://a.example.ts.net")?.label, "a.example.ts.net")
        XCTAssertEqual(Gateway.parse("https://b.example.ts.net")?.label, "b.example.ts.net")
    }

    func testAnythingWithoutASchemeWeCanLoadAndAHostIsRefused() {
        for raw in ["", "   ", "https://", "ftp://gateway.example.com", "not a url", "://gateway.example.com"] {
            XCTAssertNil(Gateway.parse(raw), "\(raw.debugDescription) should not be loadable")
        }
    }

    // MARK: - The list

    func testAFreshInstallHasNoGatewayAndAsksForOne() {
        let fresh = store()
        XCTAssertTrue(fresh.gateways.isEmpty, "nothing is compiled in, so there is nothing to fall back on")
        XCTAssertNil(fresh.activeGateway)
        XCTAssertTrue(fresh.needsSetup)
    }

    func testAddingStoresItSoTheNextLaunchHasIt() {
        let added = store().add(label: "", url: "gateway.example.com")
        // The fallback is the whole address rather than the host, which is what
        // `core/config-model.js` does and what the fixture pins: `blank` keeps an
        // empty label as given, and `add` is the one that fills it in.
        XCTAssertEqual(added?.label, "https://gateway.example.com")
        XCTAssertEqual(store().gateways.count, 1)
        XCTAssertFalse(store().needsSetup)
    }

    func testAddingSomethingUnloadableLeavesTheListAlone() {
        let configured = store()
        configured.add(label: "Home", url: "gateway.example.com")
        XCTAssertNil(configured.add(label: "Typo", url: "https://"))
        XCTAssertEqual(configured.gateways.count, 1, "a refusal stores nothing")
        XCTAssertEqual(configured.gateways.first?.label, "Home")
    }

    func testAddingDoesNotChooseTheNewGateway() {
        // Adding and connecting are two presses on the desktop, and the second one
        // is deliberate because it throws away the page you are reading. The store
        // has to keep the same shape, or the phone would switch the app out from
        // under someone halfway through adding a gateway to try.
        let configured = store()
        let first = configured.add(label: "Home", url: "home.example.ts.net")
        configured.setActive(id: first!.id)
        configured.add(label: "Work", url: "work.example.ts.net")

        XCTAssertEqual(configured.activeGateway?.label, "Home")
    }

    func testEditingTheAddressKeepsTheCredentialBecauseTheIdDoesNotMove() {
        let configured = store()
        let added = configured.add(label: "Home", url: "home.example.ts.net")!
        XCTAssertTrue(SettingsCredentials.set(added.id, field: "token", value: "secret-value"))
        defer { SettingsCredentials.forget(added.id) }

        configured.update(id: added.id, url: "home2.example.ts.net")

        XCTAssertEqual(configured.gateways.first?.url.absoluteString, "https://home2.example.ts.net")
        XCTAssertEqual(configured.gateways.first?.id, added.id, "the row is the same row")
        XCTAssertTrue(SettingsCredentials.summary(added.id).hasToken, "and it still holds its token")
    }

    func testRemovingTheActiveGatewayLeavesNothingActive() {
        let configured = store()
        let added = configured.add(label: "Home", url: "home.example.ts.net")!
        configured.setActive(id: added.id)

        configured.remove(id: added.id)

        XCTAssertTrue(configured.gateways.isEmpty)
        XCTAssertNil(configured.activeGateway)
        XCTAssertTrue(configured.needsSetup, "the surface that asks for a gateway comes back")
    }

    // MARK: - Upgrading from the single address

    func testAnInstallThatPredatesTheListKeepsItsAddressAndLoadsIt() {
        // A stored value under the old key is the only thing an upgraded install
        // has, and asking for the address again would be losing it.
        defaults.set("https://home.example.ts.net", forKey: "legacy")

        let upgraded = store()

        XCTAssertEqual(upgraded.gateways.count, 1)
        XCTAssertEqual(upgraded.gateways.first?.url.absoluteString, "https://home.example.ts.net")
        XCTAssertEqual(upgraded.activeGateway?.label, "home.example.ts.net", "it was the gateway being loaded, so it stays active")
        XCTAssertFalse(upgraded.needsSetup)
    }

    func testTheListWinsOverTheOldKeyOnceItExists() {
        let configured = store()
        configured.add(label: "New", url: "new.example.ts.net")
        // A value left under the old key, which is what an install that has since
        // been reconfigured looks like.
        defaults.set("https://old.example.ts.net", forKey: "legacy")

        XCTAssertEqual(store().gateways.first?.url.absoluteString, "https://new.example.ts.net")
    }

    func testAnUnreadableStoredValueFallsBackRatherThanCrashing() {
        defaults.set(Data("not json".utf8), forKey: "gateway")

        let recovered = store()

        XCTAssertTrue(recovered.gateways.isEmpty)
        XCTAssertTrue(recovered.needsSetup)
    }
}

import XCTest

@testable import Claw

/// The client's own gateway configuration.
///
/// Worth pinning because there is no second copy of this knowledge anywhere: no
/// address is compiled into the app and none arrives from the build, so this
/// store is the only thing that decides what the app loads. What counts as an
/// address someone can type, and that a stored one survives a relaunch, are the
/// two things a mistake here would take away.
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
        GatewayStore(defaults: defaults, key: "gateway")
    }

    // MARK: - What counts as an address

    func testABareHostGetsHTTPSBecauseThatIsWhatAPhoneKeyboardTypes() {
        let gateway = Gateway.parse("gateway.example.com")
        XCTAssertEqual(gateway?.url.absoluteString, "https://gateway.example.com")
        XCTAssertEqual(gateway?.name, "gateway.example.com")
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

    func testTheNameIsTheHostSoTwoGatewaysOnOneTailnetReadApart() {
        XCTAssertEqual(Gateway.parse("https://a.example.ts.net")?.name, "a.example.ts.net")
        XCTAssertEqual(Gateway.parse("https://b.example.ts.net")?.name, "b.example.ts.net")
    }

    func testAnythingWithoutASchemeWeCanLoadAndAHostIsRefused() {
        for raw in ["", "   ", "https://", "ftp://gateway.example.com", "not a url", "://gateway.example.com"] {
            XCTAssertNil(Gateway.parse(raw), "\(raw.debugDescription) should not be loadable")
        }
    }

    // MARK: - Storing it

    func testAFreshInstallHasNoGatewayAndAsksForOne() {
        let fresh = store()
        XCTAssertNil(fresh.gateway, "nothing is compiled in, so there is nothing to fall back on")
        XCTAssertTrue(fresh.needsSetup)
    }

    func testSavingStoresItSoTheNextLaunchLoadsIt() {
        XCTAssertTrue(store().save("gateway.example.com"))
        XCTAssertEqual(store().gateway?.url.absoluteString, "https://gateway.example.com")
        XCTAssertFalse(store().needsSetup)
    }

    func testSavingSomethingUnloadableLeavesTheWorkingAddressAlone() {
        let configured = store()
        XCTAssertTrue(configured.save("gateway.example.com"))
        XCTAssertFalse(configured.save("https://"))
        XCTAssertEqual(configured.gateway?.url.absoluteString, "https://gateway.example.com")
    }

    func testClearingBringsTheSetupSurfaceBackAndForgetsTheValue() {
        let configured = store()
        XCTAssertTrue(configured.save("gateway.example.com"))

        configured.clear()

        XCTAssertNil(configured.gateway)
        XCTAssertTrue(configured.needsSetup)
        XCTAssertNil(store().gateway, "the stored value is gone, not only forgotten in memory")
    }
}

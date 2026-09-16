import XCTest

@testable import Claw

/// What the settings page's gateway rows say, on this client.
///
/// The words are the desktop's, taken from `status()` in `core/connection.js`, and
/// this client has no port of that module: the only thing it needs is the badge,
/// because the sentence explaining a failure is raised by `NoticeBoard` from the
/// reason the OS gave. So the four labels are the one piece of that vocabulary
/// repeated here, and this is what keeps the repeat honest: reword the desktop's
/// and this fails, rather than the two clients quietly reading differently.
@MainActor
final class ConnectionStateTests: XCTestCase {
    private func gateway(_ id: String = "id-0") -> Gateway {
        Gateway(id: id, label: "example-host", url: URL(string: "https://example-host.example.ts.net")!)
    }

    func testTheRowLabelsAreTheOnesTheDesktopUses() throws {
        let source = try String(
            contentsOf: try Fixtures.root().appendingPathComponent("core").appendingPathComponent("connection.js"),
            encoding: .utf8
        )
        for label in ["Connected", "Connecting...", "Cannot connect", "Not connected"] {
            XCTAssertTrue(
                source.contains("label: '\(label)'"),
                "core/connection.js no longer says '\(label)', which this client's rows do"
            )
        }
    }

    func testAGatewayThatIsNotTheActiveOneReportsNothingAboutThePhase() {
        let state = ConnectionState()
        state.connecting("id-0")

        let other = state.status(for: gateway("id-1"), active: false)

        XCTAssertEqual(other.tone, "muted")
        XCTAssertEqual(other.label, "Not connected")
    }

    func testThePhaseMovesThroughTheThreeStatesAndIsReported() {
        let state = ConnectionState()
        let active = gateway()

        XCTAssertEqual(state.status(for: active, active: true).label, "Not connected", "nothing has been attempted yet")

        state.connecting(active.id)
        XCTAssertEqual(state.status(for: active, active: true).label, "Connecting...")
        XCTAssertEqual(state.status(for: active, active: true).tone, "muted")

        state.connected(active.id)
        XCTAssertEqual(state.status(for: active, active: true).label, "Connected")
        XCTAssertEqual(state.status(for: active, active: true).tone, "ok")

        state.failed(active.id)
        XCTAssertEqual(state.status(for: active, active: true).label, "Cannot connect")
        XCTAssertEqual(state.status(for: active, active: true).tone, "err")
    }

    func testARowSaysNothingAboutWhyItFailed() {
        // The reason belongs to the banner, which is the surface that can carry the
        // action that answers it. A row cannot be dismissed and cannot offer a way
        // out, so a second copy of the sentence there reads as a second problem.
        let state = ConnectionState()
        state.failed("id-0")

        XCTAssertNil(state.status(for: gateway(), active: true).detail)
    }
}

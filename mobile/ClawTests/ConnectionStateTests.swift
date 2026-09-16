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

    /// The pending row's two sentences are the spec's, not this file's.
    ///
    /// The row's copy comes from `core/spec/connection.json` for the same reason
    /// the phase names do: both clients have to word an unapproved device the same
    /// way, and this is the side that cannot read the file at runtime.
    func testThePendingCopyMirrorsTheSpec() throws {
        struct ConnectionSpec: Decodable {
            let phases: [String: String]
            let pendingLabel: String
            let pendingDetail: String
        }
        let spec: ConnectionSpec = try Fixtures.loadSpec("connection")
        XCTAssertEqual(ConnectionState.pendingLabel, spec.pendingLabel)
        XCTAssertEqual(ConnectionState.pendingDetail, spec.pendingDetail)
        XCTAssertEqual(ConnectionState.Phase.pending.rawValue, spec.phases["pending"], "the phase name mirrors the spec")
    }

    /// The whole reason `pending` exists: a device the gateway has not approved
    /// still gets served the page, so a load that finished is NOT an approval, and
    /// the row used to say Connected while the gateway was refusing the session.
    func testAnUnapprovedDeviceNeverReadsAsConnected() {
        let state = ConnectionState()
        let active = gateway()

        state.connecting(active.id)
        state.connected(active.id)
        XCTAssertEqual(state.status(for: active, active: true).label, "Connected", "a first connect that opened is connected")

        state.pending(active.id)
        let row = state.status(for: active, active: true)
        XCTAssertEqual(row.label, ConnectionState.pendingLabel)
        XCTAssertEqual(row.tone, "warn")
        XCTAssertEqual(row.detail, ConnectionState.pendingDetail, "the requirement is the one thing the reader has to act on")
    }

    /// The retry cadence, from the outside: a device waiting for approval is
    /// reconnected every few seconds on purpose, and each attempt reports a load
    /// starting and a page arriving. Neither may surface, or the row flickers
    /// between "Connecting..." and "Connected" once per attempt, which is the
    /// shape the pairing screen was fixed for one layer down.
    func testARetryWhilePendingNeverMovesTheRow() {
        let state = ConnectionState()
        let active = gateway("id-0")

        state.connecting(active.id)
        state.pending(active.id)

        var seen: [String] = []
        for _ in 0..<4 {
            state.connecting(active.id)
            seen.append(state.status(for: active, active: true).label)
            state.connected(active.id)
            seen.append(state.status(for: active, active: true).label)
        }
        XCTAssertEqual(Set(seen), [ConnectionState.pendingLabel], "the row moved through \(Set(seen)) instead of holding")

        // And the one move that ends the wait: a socket that survived its settle
        // window is an approval, so the row is connected on that alone.
        state.confirm()
        XCTAssertEqual(state.status(for: active, active: true).label, "Connected")
    }

    /// The moves are the shared reducer's, pinned against `core/fixtures/connection.json`
    /// the way the pairing reducer is pinned against its own fixture.
    func testNextPhaseReproducesEveryFixture() throws {
        struct Fixture: Decodable {
            struct Case: Decodable {
                let name: String
                let from: String
                let to: String
                let event: Event
                struct Event: Decodable { let type: String }
            }
            let phase: [Case]
        }
        let fixture: Fixture = try Fixtures.load("connection", as: Fixture.self)
        XCTAssertFalse(fixture.phase.isEmpty, "expected phase fixtures")
        for testCase in fixture.phase {
            let from = try XCTUnwrap(ConnectionState.Phase(rawValue: testCase.from), testCase.name)
            let expected = try XCTUnwrap(ConnectionState.Phase(rawValue: testCase.to), testCase.name)
            let event = Self.event(named: testCase.event.type)
            XCTAssertEqual(ConnectionState.nextPhase(from, event), expected, testCase.name)
        }
    }

    private static func event(named name: String) -> ConnectionState.Event {
        switch name {
        case "pending": return .pending
        case "connect": return .connect
        case "connected": return .connected
        case "confirm": return .confirm
        case "failed": return .failed
        // An event the rules do not name is the reducer's own default branch
        // rather than a fixture case this port cannot express.
        default: return .unknown
        }
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

import XCTest

@testable import Claw

/// Device pairing, proven against the same golden cases the JS side asserts on.
///
/// `core/pairing.js` reads a gateway policy close into a pairing state, keeps it
/// apart from an auth failure and a network drop, and moves through four phases;
/// `Pairing` ports those rules. This suite drives both from
/// `core/fixtures/pairing.json`, so the two clients read one gateway close the
/// same way, pull the same requestId out of the same reason, and reach the same
/// phase, rather than agreeing by luck. The observer script is not ported and so
/// is not tested here for behaviour; it is asserted byte for byte against the
/// bundled spec below, the same way the other injected scripts are.
@MainActor
final class PairingParityTests: XCTestCase {
    private struct CloseCase: Decodable {
        let name: String
        let input: CloseInput
        let output: Refusal?
    }

    private struct CloseInput: Decodable {
        let code: Int?
        let reason: String?
    }

    private struct Refusal: Decodable, Equatable {
        let reason: String
        let requestId: String?
    }

    private struct RequestIdCase: Decodable {
        let name: String
        let input: String
        let output: String?
    }

    private struct PhaseCase: Decodable {
        let name: String
        let from: String
        let event: EventCase
        let to: String
    }

    private struct EventCase: Decodable {
        let type: String
        let pairing: Refusal??
    }

    private struct CommandCase: Decodable {
        let name: String
        let input: String?
        let output: String
    }

    private struct SequenceCase: Decodable {
        let name: String
        let from: String
        let events: [EventCase]
        let phases: [String]
        let never: [String]
    }

    private struct Fixture: Decodable {
        let policyCloseCode: Int
        let close: [CloseCase]
        let requestId: [RequestIdCase]
        let phase: [PhaseCase]
        let sequence: [SequenceCase]
        let command: [CommandCase]
    }

    private func fixture() throws -> Fixture {
        try Fixtures.load("pairing")
    }

    func testReadPairingCloseReproducesEveryFixture() throws {
        let fixture = try fixture()
        XCTAssertFalse(fixture.close.isEmpty, "expected pairing close fixtures")
        for c in fixture.close {
            let got = Pairing.readPairingClose(code: c.input.code, reason: c.input.reason)
            if let expected = c.output {
                XCTAssertEqual(got?.reason, expected.reason, c.name)
                XCTAssertEqual(got?.requestId, expected.requestId, c.name)
            } else {
                XCTAssertNil(got, c.name)
            }
        }
    }

    func testAPolicyCloseIsPairingOnlyWithAPairingReason() throws {
        // The one rule a client must not collapse: 1008 is a general policy code,
        // so pairing is the code AND a pairing reason. A 1008 with any other
        // reason is an ordinary failure with its own copy, and a pairing-looking
        // reason on any other code is not pairing either.
        XCTAssertNil(Pairing.readPairingClose(code: 1008, reason: "message too large"))
        XCTAssertNil(Pairing.readPairingClose(code: 1006, reason: "pairing required"))
        XCTAssertNil(Pairing.readPairingClose(code: 1000, reason: ""))
        XCTAssertNotNil(Pairing.readPairingClose(code: 1008, reason: "pairing required"))
    }

    func testReadRequestIdReproducesEveryFixture() throws {
        let fixture = try fixture()
        XCTAssertFalse(fixture.requestId.isEmpty, "expected requestId fixtures")
        for c in fixture.requestId {
            XCTAssertEqual(Pairing.readRequestId(c.input), c.output, c.name)
        }
    }

    func testNextPhaseReproducesEveryFixture() throws {
        let fixture = try fixture()
        XCTAssertFalse(fixture.phase.isEmpty, "expected phase fixtures")
        var exercised = 0
        for c in fixture.phase {
            // The JS reducer accepts any string as the current phase and any
            // unknown event type (its `default` leaves the phase unchanged). This
            // client's `Phase` is an enum with no idle case and its `Event` is an
            // enum with no unknown case, so the two ports express "phase
            // unchanged" structurally rather than by a runtime branch: a case the
            // enums cannot represent is one the Swift reducer cannot be handed.
            // Those cases are the `idle` starting phase and the `tick` event, and
            // they are skipped here rather than forced through a fake enum case,
            // which would test the fake rather than the port. Every case both
            // enums can represent is exercised, and the count is asserted so a
            // fixture that becomes all-skippable cannot pass silently.
            guard let from = Pairing.Phase(rawValue: c.from), let event = event(c.event) else { continue }
            XCTAssertEqual(Pairing.nextPhase(from, event).rawValue, c.to, c.name)
            exercised += 1
        }
        XCTAssertGreaterThanOrEqual(exercised, 5, "expected the enum-representable phase cases to be exercised")
    }

    private func event(_ e: EventCase) -> Pairing.Event? {
        switch e.type {
        case "connect": return .connect
        case "open": return .open
        case "fail": return .fail
        case "close":
            let refusal = (e.pairing ?? nil).map {
                Pairing.Refusal(reason: $0.reason, requestId: $0.requestId)
            }
            return .close(refusal)
        default:
            // An unknown event type the Swift `Event` enum cannot represent. The
            // JS reducer leaves the phase unchanged for it; the Swift reducer
            // cannot be handed it at all, which is the same guarantee expressed in
            // the type system, so it is skipped rather than faked.
            return nil
        }
    }

    func testAnApprovalThatLandsWhilePairingWinsImmediately() {
        // Auto-recovery, as a state rule: an `open` from pairing-required is
        // authenticated. The screen comes down the moment the socket opens.
        XCTAssertEqual(Pairing.nextPhase(.pairingRequired, .open), .authenticated)
    }

    func testARetryConnectWhilePairingHoldsTheScreen() {
        // The anti-flap rule at the reducer level: a retry attempt while the
        // pairing screen is up is a `connect`, and answering it with `connecting`
        // is what made the screen flash once per retry. The device is still
        // unapproved, so the visible state holds until an `open` or a non-pairing
        // close. From any other phase a connect is still a first-connect.
        XCTAssertEqual(Pairing.nextPhase(.pairingRequired, .connect), .pairingRequired)
        XCTAssertEqual(Pairing.nextPhase(.connecting, .connect), .connecting)
        XCTAssertEqual(Pairing.nextPhase(.failed, .connect), .connecting)
    }

    func testThePairingScreenDoesNotFlapAcrossRetries() throws {
        // The flap reproduced at the level it happened: a run of retries, each a
        // `connect` followed by another pairing `close`, must leave the visible
        // phase on pairing-required throughout and never once pass through
        // `connecting`. Only an `open` or a non-pairing close ends it. Same golden
        // cases the JS side asserts, so both clients hold the screen identically.
        let fixture = try fixture()
        XCTAssertFalse(fixture.sequence.isEmpty, "expected sequence fixtures")
        for c in fixture.sequence {
            guard var phase = Pairing.Phase(rawValue: c.from) else {
                XCTFail("\(c.name): unrepresentable start phase \(c.from)")
                continue
            }
            XCTAssertEqual(c.events.count, c.phases.count, "\(c.name): one expected phase per event")
            var seen: [String] = []
            for (i, e) in c.events.enumerated() {
                guard let ev = event(e) else {
                    XCTFail("\(c.name): unrepresentable event \(e.type)")
                    continue
                }
                phase = Pairing.nextPhase(phase, ev)
                seen.append(phase.rawValue)
                XCTAssertEqual(phase.rawValue, c.phases[i], "\(c.name): step \(i)")
            }
            for banned in c.never {
                XCTAssertFalse(seen.contains(banned), "\(c.name): passed through \(banned), which is the flap")
            }
        }
    }

    func testPairingStateHoldsRefusalAndScreenAcrossARetry() {
        // The live state object, not just the reducer: a retry has to keep the
        // screen up AND keep the command on it. `connecting()` while pairing must
        // leave `isPairing` true and the refusal (its requestId, its command)
        // unchanged, so nothing on the pairing screen moves while the reconnect
        // happens underneath it.
        let state = PairingState()
        state.closed(Pairing.Refusal(reason: "not-paired", requestId: "req-7f3a2b"))
        XCTAssertTrue(state.isPairing)
        XCTAssertEqual(state.refusal?.requestId, "req-7f3a2b")
        let commandBefore = state.approveCommand

        // A retry beat: the web view calls connecting() before it reloads.
        state.connecting()
        XCTAssertTrue(state.isPairing, "the pairing screen must stay up across a retry")
        XCTAssertEqual(state.refusal?.requestId, "req-7f3a2b", "the refusal must survive a retry")
        XCTAssertEqual(state.approveCommand, commandBefore, "the command on screen must not change")

        // The approval finally lands: only now does the screen come down.
        state.opened()
        XCTAssertFalse(state.isPairing)
        XCTAssertEqual(state.phase, .authenticated)
    }

    func testPairingStateFirstConnectClearsRefusal() {
        // The other half: a genuine first connect (not from pairing-required) does
        // clear the refusal, so a stale command cannot linger into a fresh attempt.
        let state = PairingState()
        state.closed(Pairing.Refusal(reason: "not-paired", requestId: "req-1"))
        state.opened() // leave pairing so the next connect is a first-connect
        state.connecting()
        XCTAssertEqual(state.phase, .connecting)
        XCTAssertNil(state.refusal)
    }

    func testALoadFailureIsFailedNotPairing() {
        // A dropped connection and an unreachable host are the network state, kept
        // distinct from the approval one so the pairing screen never shows for a
        // failure that is not pairing.
        XCTAssertEqual(Pairing.nextPhase(.connecting, .fail), .failed)
        XCTAssertEqual(Pairing.nextPhase(.connecting, .close(nil)), .failed)
    }

    func testApproveCommandReproducesEveryFixture() throws {
        let fixture = try fixture()
        XCTAssertFalse(fixture.command.isEmpty, "expected command fixtures")
        for c in fixture.command {
            XCTAssertEqual(Pairing.approveCommand(c.input), c.output, c.name)
        }
    }

    func testTheCopyReflectsTheRealApproveInstruction() {
        // The screen shows the real instruction the gateway and the Control UI
        // give, not an invented one, and says the device cannot approve itself.
        XCTAssertTrue(Pairing.copy.commandWithId.contains("openclaw devices approve"))
        XCTAssertTrue(Pairing.copy.commandNoId.contains("openclaw devices approve --latest"))
        XCTAssertFalse(Pairing.copy.cannotRunHere.isEmpty)
    }

    func testTheObserverScriptIsTheRepositorysOneCopy() throws {
        // A mirror of a script is a second copy of it, which is the fork the
        // shared file exists to prevent. So the bundled spec's hook, joined, must
        // be exactly what the app installs, and it must post to the handler this
        // client registers.
        let specURL = try Fixtures.spec().appendingPathComponent("pairing.json")
        let data = try Data(contentsOf: specURL)
        let spec = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let hook = (spec?["hook"] as? [String])?.joined(separator: "\n")
        XCTAssertEqual(Pairing.observerScript, hook, "the installed script is the repository's copy")
        XCTAssertEqual(Pairing.messageName, spec?["messageName"] as? String)
        XCTAssertTrue(Pairing.observerScript.contains("messageHandlers.\(Pairing.messageName)"))
        XCTAssertTrue(Pairing.observerScript.contains("addEventListener('close'"))
        XCTAssertTrue(Pairing.observerScript.contains("addEventListener('open'"))
    }

    func testThePolicyCloseCodeMatchesTheGateway() throws {
        // The WebSocket "Policy Violation" code the gateway uses for a pairing
        // refusal, pinned so a spec drift on either client fails loudly rather than
        // stopping pairing being detected.
        XCTAssertEqual(Pairing.policyCloseCode, 1008)
        XCTAssertEqual(Pairing.policyCloseCode, try fixture().policyCloseCode)
    }
}

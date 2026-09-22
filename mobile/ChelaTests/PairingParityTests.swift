import Combine
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

    private struct RoutingCase: Decodable {
        let name: String
        let from: String
        let to: String
        let output: String?
    }

    private struct Fixture: Decodable {
        let policyCloseCode: Int
        let close: [CloseCase]
        let requestId: [RequestIdCase]
        let phase: [PhaseCase]
        let sequence: [SequenceCase]
        let routing: [RoutingCase]
        let command: [CommandCase]
    }

    private func fixture() throws -> Fixture {
        try Fixtures.load("pairing")
    }

    /// The routing half of `core/spec/pairing.json`, read from the repository.
    /// The client reads the bundled copy at runtime for the script and the copy
    /// the screen shows; this is the one place the route names are compared
    /// against the file they came from.
    private enum PairingSpecFile {
        struct Routing: Decodable {
            let pairingScreen: String
            let settingsGateways: String
            let settingsTab: String
        }
        struct Spec: Decodable {
            let routing: Routing
        }
        static func load() throws -> Spec {
            try Fixtures.loadSpec("pairing")
        }
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
        case "confirm": return .confirm
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

    func testAnOpenWhilePairingIsUnconfirmedAndOnlyConfirmClearsIt() {
        // The anti-flicker rule, as a state rule. A 1008 pairing close is
        // deliverable only after a WebSocket handshake completes, so the gateway
        // opens the socket and then closes it 1008 on every retry: the page's
        // socket fires `open` before the pairing close. Clearing the screen on
        // that `open` tore the overlay away for the gap between open and close,
        // once per retry, which was the flicker. So an open while pairing-required
        // HOLDS, and only a `confirm` (an open that survived the settle window
        // without a pairing close) clears the screen. A first-connect open is
        // authenticated at once, and a confirm without a held open is a no-op.
        XCTAssertEqual(Pairing.nextPhase(.pairingRequired, .open), .pairingRequired)
        XCTAssertEqual(Pairing.nextPhase(.pairingRequired, .confirm), .authenticated)
        XCTAssertEqual(Pairing.nextPhase(.connecting, .open), .authenticated)
        XCTAssertEqual(Pairing.nextPhase(.connecting, .confirm), .connecting)
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

    func testThePairingScreenDoesNotFlickerOrFlapAcrossRetries() throws {
        // Both rules reproduced at the level they happened: a run of retries, each
        // a `connect`, an `open`, and another pairing `close`, must leave the
        // visible phase on pairing-required throughout and never once pass through
        // `connecting` (the flap) OR `authenticated` (the flicker, the overlay
        // tearing away on a retry's open). Only a `confirm` or a non-pairing close
        // ends it. Same golden cases the JS side asserts, so both clients hold the
        // screen identically.
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
                XCTAssertFalse(seen.contains(banned), "\(c.name): passed through \(banned), which is a visible churn")
            }
        }
    }

    @MainActor
    func testPairingStateHoldsRefusalAndScreenAcrossARetryOpenThenClose() {
        // The live state object, not just the reducer: a retry has to keep the
        // screen up AND keep the command on it, even though every retry now both
        // opens the socket (which fires `opened`) and then has it closed 1008
        // (which fires `closed`). Neither must move the screen: `connecting()`
        // and `opened()` while pairing must leave `isPairing` true and the refusal
        // unchanged, and the pairing `closed()` that follows the open holds it too.
        let state = PairingState()
        state.closed(Pairing.Refusal(reason: "not-paired", requestId: "req-7f3a2b"))
        XCTAssertTrue(state.isPairing)
        XCTAssertEqual(state.refusal?.requestId, "req-7f3a2b")
        let commandBefore = state.approveCommand

        // A full retry beat: connect, then the socket opens, then the gateway
        // closes it 1008. This is the exact sequence that used to flicker.
        state.connecting()
        XCTAssertTrue(state.isPairing, "the pairing screen must stay up across a retry connect")
        state.opened()
        XCTAssertTrue(state.isPairing, "an unconfirmed open must not clear the screen; this was the flicker")
        XCTAssertEqual(state.phase, .pairingRequired)
        state.closed(Pairing.Refusal(reason: "not-paired", requestId: "req-7f3a2b"))
        XCTAssertTrue(state.isPairing, "the pairing close after the open must hold the screen")
        XCTAssertEqual(state.refusal?.requestId, "req-7f3a2b", "the refusal must survive a retry")
        XCTAssertEqual(state.approveCommand, commandBefore, "the command on screen must not change")
    }

    @MainActor
    func testAnApprovedOpenClearsTheScreenAfterTheSettleWindow() {
        // Auto-recovery: an open that STAYS open (no pairing close cancels it)
        // clears the screen once the settle window elapses.
        //
        // Driven through the INJECTED clock, which is the seam this state did not
        // have until 2026-09-17 and the desktop's has had since `createState` was
        // written. It is not a convenience. This rule is about a DURATION, so
        // proving it against the real clock proves the machine: with the main
        // thread starved, a 0.9s main-queue block and a 0.6s run-loop timer are
        // two unsynchronised deliveries to one thread, the block can be serviced
        // first, and the assertion then reads a screen the settle window has not
        // been given the chance to clear. That is exactly what all three iOS 27
        // failures were, and it is why this is a fake clock now.
        let clock = TestClock()
        let state = PairingState(clock: clock.clock())
        state.closed(Pairing.Refusal(reason: "not-paired", requestId: "req-7f3a2b"))
        state.connecting()
        state.opened()
        // The open is held until it settles: still pairing right after, and the
        // only thing armed for the screen is the settle window itself.
        XCTAssertTrue(state.isPairing, "an open is unconfirmed until the settle window elapses")
        XCTAssertTrue(
            clock.delays.contains(PairingState.confirmInterval),
            "the settle window must be armed when an unconfirmed open arrives"
        )

        // Let the settle window elapse (no closed() cancels it): the screen clears.
        clock.tick()
        XCTAssertFalse(state.isPairing, "an approved open must clear the screen after settling")
        XCTAssertEqual(state.phase, .authenticated)
        XCTAssertNil(state.refusal)
        XCTAssertEqual(clock.armed, 0, "no cadence is left running once the screen is down")
    }

    @MainActor
    func testAPairingCloseAfterAnOpenCancelsTheSettleSoTheScreenNeverClears() {
        // The other half of the anti-flicker guard: a pairing close arriving after
        // an unconfirmed open must cancel the settle, so a confirm cannot race in
        // and clear a screen that should stay up. After the close, the settle
        // window passes and the screen is still up.
        //
        // On the injected clock for the reason above, and this is the test the
        // iOS 27 leg failed the other way round on 2026-09-17: its expectation was
        // never fulfilled inside its own timeout, because the block that fulfilled
        // it was starved of the main thread for longer than the whole wait.
        let clock = TestClock()
        let state = PairingState(clock: clock.clock())
        state.closed(Pairing.Refusal(reason: "not-paired", requestId: "req-7f3a2b"))
        state.connecting()
        state.opened()                 // arms the settle window
        state.closed(Pairing.Refusal(reason: "not-paired", requestId: "req-7f3a2b")) // cancels it
        XCTAssertFalse(
            clock.delays.contains(PairingState.confirmInterval),
            "a refusal after the open must take the settle window away, not leave it to fire"
        )

        // And the window passing changes nothing: only the retry cadence is left.
        clock.tick()
        XCTAssertTrue(state.isPairing, "a refusal after the open must keep the screen up")
        XCTAssertEqual(state.phase, .pairingRequired)
    }

    /// The cadence is the shared spec's, not a number kept in this client.
    ///
    /// The Swift half of the assertion `core/test/pairing.test.js` makes about
    /// `RETRY_SECONDS` and `CONFIRM_SECONDS`, and it is here because the port used
    /// to keep its own `3` and `0.6` while the spec said otherwise in the same
    /// breath: a tune of `confirmSeconds` would have reached the desktop and left
    /// the phone on the old window, which is a divergence with no symptom until
    /// somebody reports one client flickering.
    func testTheCadenceIsTheSpecsNotThisClients() throws {
        struct PairingSpec: Decodable {
            struct Timing: Decodable {
                let retrySeconds: Double
                let confirmSeconds: Double
            }
            let timing: Timing
        }
        let spec: PairingSpec = try Fixtures.loadSpec("pairing")

        XCTAssertEqual(Pairing.retrySeconds, spec.timing.retrySeconds, "the retry cadence comes from the spec")
        XCTAssertEqual(Pairing.confirmSeconds, spec.timing.confirmSeconds, "and so does the settle window")
        XCTAssertEqual(PairingState.retryInterval, spec.timing.retrySeconds)
        XCTAssertEqual(PairingState.confirmInterval, spec.timing.confirmSeconds)

        // The two invariants the spec names for the pair, asserted here so a spec
        // edit that broke one would fail on both clients rather than only where
        // the relationship is written down.
        XCTAssertGreaterThan(PairingState.confirmInterval, 0, "a window of zero would clear the screen on the open itself")
        XCTAssertLessThan(
            PairingState.confirmInterval,
            PairingState.retryInterval,
            "confirm must sit inside retry, or an approval waits for the next beat"
        )
    }

    /// The real clock is still wired.
    ///
    /// The rules above are proven on an injected clock, so something has to prove
    /// the production half actually delivers its callbacks; otherwise the seam
    /// would be a way of never testing the live path at all. Deliberately one
    /// assertion about the END state and none about the screen before the window
    /// elapses: "still pairing at 0.6s" is precisely the claim that needs a clock
    /// nobody in this process controls, and it belongs on the fake above.
    ///
    /// The expectation is fulfilled by the state itself rather than by a deadline
    /// of its own, which is what removes the race rather than narrowing it: a
    /// second competing deadline is the whole fault this arrangement fixes.
    @MainActor
    func testTheLiveClockDeliversTheSettleWindow() {
        let state = PairingState()
        state.closed(Pairing.Refusal(reason: "not-paired", requestId: "req-live-1"))
        state.connecting()
        state.opened()
        XCTAssertTrue(state.isPairing, "an open is unconfirmed until the settle window elapses")

        let cleared = expectation(description: "the live clock clears the screen")
        let observer = state.$phase.sink { phase in
            if phase == .authenticated { cleared.fulfill() }
        }
        wait(for: [cleared], timeout: PairingState.confirmInterval + 30)
        withExtendedLifetime(observer) {}

        XCTAssertFalse(state.isPairing, "an approved open must clear the screen on the live clock too")
        XCTAssertNil(state.refusal)
    }

    @MainActor
    func testPairingStateFirstConnectClearsRefusal() {
        // A genuine first connect (not from pairing-required) clears the refusal,
        // so a stale command cannot linger into a fresh attempt. A first-connect
        // open (from connecting, no screen up) authenticates at once, which is how
        // we leave pairing here to set up the first-connect case.
        let state = PairingState()
        state.closed(Pairing.Refusal(reason: "not-paired", requestId: "req-1"))
        state.connecting()
        state.failed()          // leave pairing cleanly so the next open is a first-connect
        state.connecting()
        state.opened()          // from connecting: authenticated at once, no settle needed
        XCTAssertEqual(state.phase, .authenticated)
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

    /// Where a pairing close sends the reader, which is not one answer: a first
    /// connection is a setup problem and the pairing screen is it, and the same
    /// close on a session that was working is a revocation that wants the gateway
    /// list. Proven against the shared fixture so this client cannot route one
    /// event one way while the desktop routes it the other.
    func testPairingRouteReproducesEveryFixture() throws {
        let fixture = try fixture()
        XCTAssertFalse(fixture.routing.isEmpty, "expected routing fixtures")
        for c in fixture.routing {
            let from = try XCTUnwrap(Pairing.Phase(rawValue: c.from), c.name)
            let to = try XCTUnwrap(Pairing.Phase(rawValue: c.to), c.name)
            XCTAssertEqual(Pairing.route(fromPhase: from, toPhase: to), c.output, c.name)
        }
    }

    /// The two route names are the spec's, not literals of this client's.
    func testTheRouteNamesComeFromTheSpec() throws {
        XCTAssertEqual(Pairing.route(fromPhase: .authenticated), Pairing.routeSettingsGateways)
        XCTAssertEqual(Pairing.route(fromPhase: .connecting), Pairing.routePairingScreen)
        XCTAssertEqual(Pairing.route(fromPhase: .failed), Pairing.routePairingScreen)
        XCTAssertNil(Pairing.route(fromPhase: .authenticated, toPhase: .authenticated), "not a pairing entry, so nothing routes")

        let spec = try PairingSpecFile.load()
        XCTAssertEqual(Pairing.routeSettingsGateways, spec.routing.settingsGateways)
        XCTAssertEqual(Pairing.routePairingScreen, spec.routing.pairingScreen)
        XCTAssertEqual(Pairing.routeSettingsTab, spec.routing.settingsTab)
    }

    /// A live transition, which is the part a fixture cannot show: a session that
    /// was authenticated and then had its approval revoked publishes the settings
    /// route, and a first connection publishes the pairing screen.
    func testARevokedSessionPublishesTheSettingsRoute() {
        let state = PairingState()
        state.opened()
        XCTAssertEqual(state.phase, .authenticated)
        XCTAssertNil(state.route, "nothing is pairing, so there is nowhere to route")

        state.closed(Pairing.Refusal(reason: "not-paired", requestId: "req-established-1"))
        XCTAssertEqual(state.phase, .pairingRequired)
        XCTAssertEqual(state.route, Pairing.routeSettingsGateways)

        // And the retries that follow hold it: a repeat close, or an attempt
        // starting, must not turn a revocation into a first connection.
        state.connecting()
        state.closed(Pairing.Refusal(reason: "not-paired", requestId: "req-established-1"))
        XCTAssertEqual(state.route, Pairing.routeSettingsGateways)
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
        // And the guard that decides WHICH socket may become the session, because
        // the phone hosts the same Control UI page and its browser panel streams
        // over a WebSocket of its own: without it, closing a panel on the phone
        // raises the failure surface exactly as it did on the desktop, and a panel
        // refresh re-runs the client's load path.
        XCTAssertTrue(Pairing.observerScript.contains("sessionEndpoint"),
                      "the installed script no longer gates which socket may be adopted")
    }

    func testThePolicyCloseCodeMatchesTheGateway() throws {
        // The WebSocket "Policy Violation" code the gateway uses for a pairing
        // refusal, pinned so a spec drift on either client fails loudly rather than
        // stopping pairing being detected.
        XCTAssertEqual(Pairing.policyCloseCode, 1008)
        XCTAssertEqual(Pairing.policyCloseCode, try fixture().policyCloseCode)
    }
}

/// A clock with no time in it: pending callbacks, fired on demand.
///
/// The mirror of `fakeClock()` in `desktop/test/pairing.test.js`, injected
/// through the same `PairingClock` seam and with the same shape, so the two
/// clients' suites drive one state machine the same way: schedule, cancel, fire
/// everything shortest first so a beat can re-arm one. `delays` is what lets a
/// test assert WHICH window was armed rather than only that something was, which
/// is the assertion the JS side makes about `CONFIRM_SECONDS`.
@MainActor
private final class TestClock {
    private struct Pending {
        let id: Int
        let delay: TimeInterval
        let body: @MainActor () -> Void
    }

    private var pending: [Pending] = []
    private var sequence = 0

    /// The seam, bound to this clock.
    func clock() -> PairingClock {
        PairingClock(
            schedule: { seconds, body in
                self.sequence += 1
                let id = self.sequence
                self.pending.append(Pending(id: id, delay: seconds, body: body))
                return PairingClock.Handle { self.pending.removeAll { $0.id == id } }
            },
            cancel: { handle in handle.cancel() }
        )
    }

    /// Every delay currently armed.
    var delays: [TimeInterval] { pending.map(\.delay) }

    /// How many callbacks are still armed. Zero is "no cadence is left running".
    var armed: Int { pending.count }

    /// Fire everything pending, shortest delay first, so a beat can re-arm one.
    func tick() {
        for entry in pending.sorted(by: { $0.delay < $1.delay }) {
            guard let index = pending.firstIndex(where: { $0.id == entry.id }) else { continue }
            let timer = pending.remove(at: index)
            timer.body()
        }
    }
}

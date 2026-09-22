import Foundation
import XCTest

@testable@testable import Chela

/// The shared About page, as this client carries and answers it.
///
/// About is the desktop's own `core/ui/about.html`, rendered on the phone rather
/// than reimplemented, so the same two failure modes the settings page has apply
/// here and neither is visible at runtime:
///
/// 1. **the bundled copy drifting from the repository's**, or a file the page's
///    own relative links name missing from the bundle, which would leave About
///    blank or unstyled;
/// 2. **a command the page asks for that the host does not implement**, which is a
///    button that does nothing, or one the host implements that the page never
///    calls, which is a door onto work the page never asked for.
///
/// The page reaches this client through `window.clawDesktop`, the same global the
/// desktop's preload builds, and `AboutHost` is what answers it here. The sources
/// and the page are read from the repository by walking up from this file, exactly
/// as the other parity tests do.
final class AboutHostTests: XCTestCase {
    // MARK: What ships

    func testTheAboutPageAndTheFilesItAsksForAreAllInTheBundle() {
        // about.html's own relative links load the stylesheet, the script and the
        // header icon, so all of them have to be in the bundle or the page renders
        // unstyled, inert, or with a broken image. `AboutSurface.directory` is the
        // read-access root the web view is loaded with, and this asserts the files
        // the page's links name against it.
        let directory = AboutSurface.directory
        XCTAssertNotNil(AboutSurface.page, "core/ui/about.html is not in the bundle")
        // `surface.js` travels with the page for the same reason the stylesheet
        // does: about.html loads it as one of its own relative links, so a bundle
        // without it serves a page with a dead reference.
        for name in ["about.html", "about.js", "ui.css", "surface.js"] {
            let url = directory?.appendingPathComponent(name)
            XCTAssertNotNil(url)
            XCTAssertTrue(
                url.map { FileManager.default.fileExists(atPath: $0.path) } ?? false,
                "\(name) is not beside the About page in the bundle"
            )
        }
        // The header icon is under assets/, kept as a subdirectory so the
        // `src="assets/claw.svg"` link resolves rather than being flattened.
        let icon = directory?.appendingPathComponent("assets").appendingPathComponent("claw.svg")
        XCTAssertTrue(
            icon.map { FileManager.default.fileExists(atPath: $0.path) } ?? false,
            "assets/claw.svg is not in the bundle, so the About header icon would be broken"
        )
    }

    func testTheBundledAboutPageIsTheRepositorysCopyByteForByte() throws {
        // The page and its script are the desktop's own files. A bundled copy that
        // drifted from the repository's would leave the phone rendering a page
        // nobody is editing, the same drift `SettingsSpecTests` guards for settings.
        let ui = try Fixtures.root().appendingPathComponent("core").appendingPathComponent("ui")
        for name in ["about.html", "about.js"] {
            let bundled = try XCTUnwrap(
                AboutSurface.directory?.appendingPathComponent(name),
                "\(name) is not in the bundle"
            )
            let repo = ui.appendingPathComponent(name)
            XCTAssertEqual(
                try Data(contentsOf: bundled),
                try Data(contentsOf: repo),
                "the bundled \(name) has drifted from core/ui/\(name)"
            )
        }
    }

    // MARK: The contract

    func testEveryCommandThePageCallsIsImplementedByTheHost() throws {
        // The page reaches its host through `window.clawDesktop.<command>(...)`, so
        // the set of commands it uses is the set of methods it names on that global.
        // Every one of them has to be answered here or it is a control that does
        // nothing, and the host must implement no command the page never calls, or
        // it is a door onto work the surface never asked for. This reads the page's
        // own script for the calls and this host's switch for the answers, the same
        // way SettingsSpecTests reads the settings page and host.
        let ui = try Fixtures.root().appendingPathComponent("core").appendingPathComponent("ui")
        let script = try String(contentsOf: ui.appendingPathComponent("about.js"), encoding: .utf8)

        // Every `api.<name>(` and `window.clawDesktop.<name>(` the page calls. The
        // page aliases the global as `api` at the top, so both spellings are read.
        var called = Set<String>()
        for pattern in [/\bapi\.([a-zA-Z]+)\(/, /window\.clawDesktop\.([a-zA-Z]+)\(/] {
            for match in script.matches(of: pattern) {
                called.insert(String(match.output.1))
            }
        }
        XCTAssertFalse(called.isEmpty, "found no clawDesktop calls in about.js: the matcher is wrong")

        // The commands answered by the host. The bootstrap script it injects names
        // each one on the `window.clawDesktop` object it builds, so the surface the
        // page sees is exactly what the bootstrap exposes; that is read here rather
        // than the switch, because a command exposed but not switched still throws,
        // and a command switched but not exposed is unreachable. Both are bugs, and
        // the exposed set is the one the page can actually reach.
        let bootstrap = MainActor.assumeIsolated {
            AboutHost(notices: NoticeBoard(), onClose: {}).bootstrapScript()
        }
        var exposed = Set<String>()
        for match in bootstrap.matches(of: /\b([a-zA-Z]+): function/) {
            exposed.insert(String(match.output.1))
        }
        XCTAssertFalse(exposed.isEmpty, "the bootstrap exposes no commands: the matcher is wrong")

        for command in called {
            XCTAssertTrue(
                exposed.contains(command),
                "about.js calls clawDesktop.\(command), which this host does not expose"
            )
        }
        for command in exposed {
            XCTAssertTrue(
                called.contains(command),
                "this host exposes \(command), which about.js never calls"
            )
        }
    }

    // MARK: The state

    func testTheStateCarriesTheKeysThePageDraws() {
        // The page reads these off the state it is handed. A missing key is a row
        // the page draws from `undefined`, which on the facts list is a crash and on
        // the update card is a line reading "undefined". The desktop's aboutState()
        // is the other half of this shape; this asserts the phone's half carries the
        // same keys the shared page reads.
        // Read the assertions inside the actor's isolation and carry back only
        // Sendable results: the state dictionary is `[String: Any]`, which does not
        // cross the actor boundary, so what leaves the closure is the set of keys
        // present and the facts as string pairs.
        let (keys, facts): (Set<String>, [[String: String]]) = MainActor.assumeIsolated {
            let state = AboutHost(notices: NoticeBoard(), onClose: {}).state
            let present = Set(state.keys)
            let facts = state["facts"] as? [[String: String]] ?? []
            return (present, facts)
        }
        for key in ["build", "updateStatus", "updateReady", "canInstall", "autoUpdate", "facts", "controlUI"] {
            XCTAssertTrue(keys.contains(key), "the About state is missing \(key), which the page reads")
        }

        // The facts are a list of { label, value } pairs, both strings, which is
        // what the page maps into rows.
        XCTAssertFalse(facts.isEmpty, "the facts list is empty, so About would show no build details")
        for fact in facts {
            XCTAssertNotNil(fact["label"], "a fact has no label")
            XCTAssertNotNil(fact["value"], "a fact has no value")
        }
    }

    // MARK: The reference

    /// The pin, as the repository has it.
    private func repositoryPin() throws -> (version: String, commit: String) {
        struct Pin: Decodable {
            struct Upstream: Decodable {
                let version: String
                let commit: String
            }

            let upstream: Upstream
        }
        let url = try Fixtures.root()
            .appendingPathComponent("core")
            .appendingPathComponent("spec")
            .appendingPathComponent("upstream-reference.json")
        let pin = try JSONDecoder().decode(Pin.self, from: Data(contentsOf: url))
        return (pin.upstream.version, pin.upstream.commit)
    }

    func testTheBundledPinIsTheRepositorysCopyByteForByte() throws {
        // The pin is the one owner of which Control UI this build targets, and the
        // page names it from the copy in this bundle. A bundled copy that drifted
        // from the repository's would leave the phone's About naming a revision
        // nobody is editing against, the same drift this file guards for the page
        // itself.
        let bundled = try XCTUnwrap(
            Bundle.main.url(forResource: "upstream-reference", withExtension: "json"),
            "core/spec/upstream-reference.json is not in the bundle, so About would name no Control UI"
        )
        let repo = try Fixtures.root()
            .appendingPathComponent("core")
            .appendingPathComponent("spec")
            .appendingPathComponent("upstream-reference.json")
        XCTAssertEqual(
            try Data(contentsOf: bundled),
            try Data(contentsOf: repo),
            "the bundled pin has drifted from core/spec/upstream-reference.json"
        )
    }

    func testTheStateNamesTheControlUIThePinRecords() throws {
        // What this catches is the pair going out of step, in the direction that is
        // invisible: a revision written into this client instead of read from the
        // pin agrees with it on the day it is typed and keeps agreeing after the
        // pin moves. So both fields are compared against the file rather than
        // asserted to exist.
        let (version, commit) = try repositoryPin()
        let reference: [String: String]? = MainActor.assumeIsolated {
            let state = AboutHost(notices: NoticeBoard(), onClose: {}).state
            return state["controlUI"] as? [String: String]
        }
        let carried = try XCTUnwrap(
            reference,
            "the About state carries no controlUI, so About names no Control UI revision"
        )
        XCTAssertEqual(
            carried["version"], version,
            "About names a different Control UI version from the one the pin records"
        )
        XCTAssertEqual(
            carried["commit"], commit,
            "About names a different commit from the one the pin records"
        )
    }
}

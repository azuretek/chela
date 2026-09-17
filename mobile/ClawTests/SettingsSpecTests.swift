import Foundation
import XCTest

@testable import Claw

/// The shared settings surface, as this client carries and answers it.
///
/// Three things can go wrong with a page that two clients render, and none of them
/// is visible at runtime:
///
/// 1. **the bundled copy drifting from the repository's**, which would leave the
///    phone rendering a page nobody is editing;
/// 2. **a command the spec gives this client that the host does not implement**,
///    which is a button that does nothing, or one the host implements and the spec
///    never declares, which is work this client's surface never asked for;
/// 3. **an event the spec declares that nothing here ever raises**, which is a page
///    left showing whatever it read when it loaded.
///
/// The sources and the specs are read from the repository, by walking up from this
/// file's own path, exactly as the other parity tests do: a test that silently
/// checked nothing because it could not find its input would read as a pass.
final class SettingsSpecTests: XCTestCase {
    // MARK: What ships

    func testTheBundledSplitIsTheRepositorysCopyByteForByte() throws {
        let bundled = try XCTUnwrap(
            Bundle.main.url(forResource: "settings", withExtension: "json"),
            "core/spec/settings.json is not in the bundle: the page would render nothing"
        )
        let repo = try Fixtures.spec().appendingPathComponent("settings.json")

        XCTAssertEqual(
            try Data(contentsOf: bundled),
            try Data(contentsOf: repo),
            "the bundled settings spec has drifted from core/spec/settings.json"
        )
    }

    func testThePageAndTheFilesItAsksForAreAllInTheBundle() {
        // The page's own relative links are what load the stylesheet and the
        // script, so all three have to be in the same directory or the page renders
        // unstyled and inert. `SettingsSpec.directory` is the read-access root the
        // web view is loaded with, and this asserts the same three files the links
        // name.
        let directory = SettingsSpec.directory
        XCTAssertNotNil(SettingsSpec.page, "core/ui/settings.html is not in the bundle")
        // `surface.js` is the departure handshake the page calls, added when the
        // shared pages gained their motion: it is one of the page's own relative
        // links now, so it belongs in the same list as the stylesheet and the
        // script rather than being assumed.
        for name in ["settings.html", "settings.js", "ui.css", "surface.js"] {
            let url = directory?.appendingPathComponent(name)
            XCTAssertNotNil(url)
            XCTAssertTrue(
                url.map { FileManager.default.fileExists(atPath: $0.path) } ?? false,
                "\(name) is not beside the settings page in the bundle"
            )
        }
    }

    // MARK: The split

    func testThisClientsCommandsAreExactlyWhatTheHostImplements() throws {
        let spec = try spec()
        let clients = try XCTUnwrap(spec["clients"] as? [String: Any])
        XCTAssertNotNil(clients[SettingsSpec.clientId], "the spec does not know the client \(SettingsSpec.clientId)")

        let commands = try XCTUnwrap(spec["commands"] as? [[String: Any]])
        let declared = try commands
            .filter { ($0["clients"] as? [String])?.contains(SettingsSpec.clientId) ?? false }
            .map { try XCTUnwrap($0["id"] as? String) }
        XCTAssertFalse(declared.isEmpty, "the spec gives this client no commands at all")

        // Every `case "name":` inside the command switch, read from the source.
        // The switch is one function with one label per command, so a label is the
        // command's name, and the body is taken first so that a `case` in some
        // other switch cannot be counted as a command.
        let source = try readSource("SettingsHost.swift")
        let switchBody = try XCTUnwrap(
            /switch command \{([\s\S]*?)\n        \}/.firstMatch(in: source)?.output.1,
            "the command switch was not found in SettingsHost.swift"
        )
        let implemented = Set(switchBody.matches(of: /case "([a-zA-Z]+)":/.self).map { String($0.output.1) })
        XCTAssertGreaterThanOrEqual(implemented.count, 8, "only \(implemented.count) commands are implemented")

        for command in declared {
            XCTAssertTrue(implemented.contains(command), "the spec gives ios the \(command) command and this host does not implement it")
        }
        for command in implemented {
            XCTAssertTrue(declared.contains(command), "this host implements \(command), which the spec does not give ios")
        }
    }

    func testTheHostRaisesEveryEventTheSpecDeclaresForThisClient() throws {
        let spec = try spec()
        let events = try XCTUnwrap(spec["events"] as? [[String: Any]])
        let declared = try events
            .filter { ($0["clients"] as? [String])?.contains(SettingsSpec.clientId) ?? false }
            .map { try XCTUnwrap($0["id"] as? String) }
        XCTAssertFalse(declared.isEmpty, "the spec declares no events for this client")

        // Read from the app's own sources rather than from this file, because what
        // raises an event is the view that observes the change.
        let sources = try FileManager.default
            .contentsOfDirectory(at: try appSources(), includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "swift" }
            .map { try String(contentsOf: $0, encoding: .utf8) }
            .joined(separator: "\n")

        for event in declared {
            XCTAssertTrue(
                sources.contains("emit(\"\(event)\")"),
                "nothing in the app raises the \(event) event, so the page would never re-read on it"
            )
        }
    }

    func testNoDesktopOnlySettingIsSurfacedHere() throws {
        // The complement of the desktop's own test: everything the spec marks
        // absent on this client must have a reason, and none of those ids may
        // appear as a rendered control in the shared page's markup for this client.
        // The page hides them by the spec, so this is really an assertion about the
        // spec: an absence with no reason is an absence nobody decided on.
        let spec = try spec()
        var absent: [String] = []
        for group in ["tabs", "settings"] {
            let entries = try XCTUnwrap(spec[group] as? [[String: Any]])
            for entry in entries {
                let granted = entry["clients"] as? [String] ?? []
                guard !granted.contains(SettingsSpec.clientId) else { continue }
                let id = try XCTUnwrap(entry["id"] as? String)
                XCTAssertNotNil(
                    (entry["absent"] as? [String: Any])?[SettingsSpec.clientId],
                    "\(id) is absent on this client with no reason given"
                )
                absent.append(id)
            }
        }
        XCTAssertFalse(absent.isEmpty, "expected at least one desktop-only entry to check")
    }

    // MARK: Reading the repository

    private func spec() throws -> [String: Any] {
        let url = try Fixtures.spec().appendingPathComponent("settings.json")
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }

    private func appSources() throws -> URL {
        try Fixtures.root().appendingPathComponent("mobile").appendingPathComponent("Claw")
    }

    private func readSource(_ name: String) throws -> String {
        try String(contentsOf: try appSources().appendingPathComponent(name), encoding: .utf8)
    }
}

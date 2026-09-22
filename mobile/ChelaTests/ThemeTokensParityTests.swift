import XCTest

@testable import Chela

/// Parity with `core/spec/tokens.json`'s `live` list, the one owner of which
/// tokens a client takes from a running Control UI.
///
/// The desktop reads that list in Node (`core/tokens.js`, re-exported as
/// `THEME_TOKENS` by `desktop/src/chrome.js`) and hands the values to our own
/// pages as CSS. This client mirrors the list, because a shipped app cannot read
/// a file that lives in the repo, and applies the values with CSSOM. Two clients,
/// one list, and this test is what keeps the mirror honest: measured the hard way
/// on 2026-09-16, when the list was the desktop's alone and the iOS settings and
/// About surfaces were the only ones wearing the system font and a neutral grey
/// palette while the interface beside them was Instrument Sans on `#0e1015`.
final class ThemeTokensParityTests: XCTestCase {
    private func spec() throws -> TokensSpec {
        try Fixtures.loadSpec("tokens")
    }

    func testTheMirroredListIsTheSpecListInTheSameOrder() throws {
        let live = try spec().live
        XCTAssertFalse(live.tokens.isEmpty, "the spec's live list is empty, so nothing is being taken from the UI")

        let expected = live.tokens.compactMap { pair -> (String, String)? in
            guard pair.count == 2 else { return nil }
            return (pair[0], pair[1])
        }
        XCTAssertEqual(expected.count, live.tokens.count, "a live entry is not a [name, kind] pair")

        XCTAssertEqual(ThemeTokens.live.map(\.name), expected.map(\.0), "the names have drifted from the spec")
        XCTAssertEqual(ThemeTokens.live.map(\.kind), expected.map(\.1), "the kinds have drifted from the spec")
    }

    func testTheKindsAreOnesTheSpecUses() throws {
        // The phone does not branch on the kind (CSSOM needs no grammar), so this
        // is not about applying them: it is that a kind nobody recognises means the
        // desktop's sanitizer has a value it will silently drop, which would leave
        // the two clients wearing different palettes from the same page.
        let kinds = Set(try spec().live.tokens.compactMap { $0.count == 2 ? $0[1] : nil })
        XCTAssertFalse(kinds.isEmpty)
        for (name, kind) in ThemeTokens.live {
            XCTAssertTrue(kinds.contains(kind), "\(name) is mirrored with kind \(kind), which the spec does not use")
        }
    }

    func testTheProbeAsksForExactlyTheMirroredNames() {
        let probe = ThemeTokens.probeScript
        for name in ThemeTokens.names {
            XCTAssertTrue(probe.contains("\"\(name)\""), "the probe never asks the page for \(name)")
        }
        // Read from the computed style of the root, which is what flattens a
        // palette authored in color-mix() or oklch() into a value CSSOM can carry.
        XCTAssertTrue(probe.contains("getComputedStyle"), "the probe does not read computed values")
    }

    func testTheProbeReadsTheResolvedAppearanceThePaletteBelongsTo() {
        // Not `prefers-color-scheme`, which is the DEVICE's answer: the question is
        // which appearance the injected palette is in, and the Control UI says so
        // on its own root before its stylesheets load.
        let probe = ThemeTokens.probeScript
        XCTAssertTrue(probe.contains("data-theme-mode"),
                      "the probe does not read the Control UI's resolved mode")
        XCTAssertTrue(probe.contains(ThemeTokens.schemeKey),
                      "the probe does not return the resolved appearance")
        XCTAssertTrue(probe.contains("'light' && mode === 'dark'") || probe.contains("mode === 'light'"),
                      "the probe does not refuse an ambiguous answer, so a page with no mode pinned would set one")
        XCTAssertFalse(probe.contains("matchMedia"),
                       "the probe is asking the device's appearance rather than the palette's")
    }

    func testTheSchemeIsWrittenAsColorSchemeAndNothingElse() {
        // The failure this guards is silent by construction: a colour scheme set as
        // a CUSTOM PROPERTY sits in the page being read by nobody, so the appearance
        // looks applied and the platform chrome carries on disagreeing with it.
        //
        // These are assertions about the script's TEMPLATE, which is all a Swift
        // test can see: what the generated code does with a given value is measured
        // in the page. So the template has to say all three things -- write the real
        // property, refuse a value that is not an appearance, and do both only for
        // the one key -- and the ORDER matters, because a scheme branch that came
        // before the prefix guard would take an unprefixed name from the page.
        let script = ThemeTokens.applyScript([ThemeTokens.schemeKey: "light", "--bg": "#faf9f7"])
        XCTAssertTrue(script.contains("root.style.colorScheme = value"),
                      "the resolved appearance is not written as color-scheme")
        XCTAssertTrue(script.contains("value !== 'light' && value !== 'dark'"),
                      "the apply script would pin the page to a value that is not an appearance")
        XCTAssertTrue(script.contains("style.setProperty"), "the apply script stopped writing custom properties")

        let guardAt = script.range(of: "name.indexOf('--') !== 0")
        let branchAt = script.range(of: "if (name === schemeKey)")
        XCTAssertNotNil(guardAt, "the apply script lost its name guard")
        XCTAssertNotNil(branchAt, "the apply script does not branch on the scheme key")
        if let guardAt, let branchAt {
            XCTAssertLessThan(guardAt.lowerBound, branchAt.lowerBound,
                              "the scheme branch runs before the prefix guard, so an unprefixed name could reach the page")
        }
    }

    func testTheApplyScriptWritesCustomPropertiesThroughCSSOM() {
        let script = ThemeTokens.applyScript(["--bg": "#0e1015", "--font-body": "Instrument Sans"])
        // CSSOM, not stylesheet text. A custom property set with setProperty cannot
        // escape its own declaration, which is why this client needs no sanitizer
        // while the desktop's concatenating path does.
        XCTAssertTrue(script.contains("style.setProperty"), "the apply script does not use CSSOM")
        XCTAssertFalse(script.contains("innerHTML"), "the apply script builds markup")
        XCTAssertFalse(script.contains("insertRule"), "the apply script writes a stylesheet")
        XCTAssertTrue(script.contains("name.indexOf('--') !== 0"), "the apply script has no name guard")
        XCTAssertTrue(script.contains("__clawApplyLiveTokens"), "the apply script is not re-runnable")
        XCTAssertTrue(script.contains("#0e1015"), "the values are not in the script")
        XCTAssertTrue(script.contains("Instrument Sans"), "the values are not in the script")
        // A map arrives from the gateway page's own values, so the map's NAMES are
        // what has to be refused, and the JSON of a name that is not a custom
        // property has to be in the script without a write behind it. Checked as
        // the serialized name, not as an outcome: the outcome is the page's, and a
        // Swift test asserting the outcome would be asserting its own template.
        let hostile = ThemeTokens.applyScript(["colorScheme": "dark"])
        XCTAssertTrue(hostile.contains("\"colorScheme\""), "the hostile map did not reach the script")
        XCTAssertTrue(hostile.contains("name.indexOf('--') !== 0"),
                      "the hostile map would be applied with no prefix guard in front of it")
    }

    func testAnEmptyMapIsStillAValidApplyScript() {
        // The no-gateway case, and the first frame of every sheet: nothing to
        // apply, and the page keeps ui.css's fallback palette.
        let script = ThemeTokens.applyScript([:])
        XCTAssertTrue(script.contains("setProperty"), "an empty map produced a script that cannot apply anything")
        XCTAssertTrue(script.contains("DOMContentLoaded"), "the script does not retry when the root is not there yet")
    }
}

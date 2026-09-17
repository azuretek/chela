import XCTest

@testable import Claw

/// Parity with `core/notices.js`, proven against the same golden fixtures the JS
/// side asserts in `core/test/fixtures.test.js`.
///
/// This is the mechanism the design leans on so the two clients cannot drift: the
/// fixtures are generated from the JS, both clients reproduce them, and so "the
/// phone and the desktop raise, sort and clear the same conditions" is a thing
/// that is checked rather than hoped for. Changing the model means regenerating
/// the fixtures, and this test is what makes the Swift move with them.
///
/// The fixtures are a sequence of operations rather than a single call, because
/// the store's rules are about what changes *between* calls: an id replaces rather
/// than stacks, an identical raise reports no change so the banner does not
/// re-render, reading leaves the notice in the store, and a notice that changes
/// after being read becomes unread again. Each step's return value is asserted as
/// well as the state at the end, since every one of those rules is answered by the
/// boolean rather than by the dictionary.
final class NoticesParityTests: XCTestCase {
    func testSentenceReproducesEveryFixture() throws {
        let fixture: NoticesFixture = try Fixtures.load("notices")
        XCTAssertFalse(fixture.sentence.isEmpty, "expected sentence cases in core/fixtures/notices.json")
        for testCase in fixture.sentence {
            XCTAssertEqual(
                noticeSentence(testCase.input),
                testCase.output,
                "noticeSentence(\(testCase.input ?? "nil")) should be \(testCase.output)"
            )
        }
    }

    func testStoreReproducesEveryFixture() throws {
        let fixture: NoticesFixture = try Fixtures.load("notices")
        XCTAssertFalse(fixture.store.isEmpty, "expected store cases in core/fixtures/notices.json")
        for testCase in fixture.store {
            let store = NoticeStore()
            var returns: [Bool] = []
            for op in testCase.ops {
                returns.append(apply(op, to: store))
            }
            XCTAssertEqual(returns, testCase.returns, "\(testCase.name): the returns disagree")
            XCTAssertEqual(snapshot(store), testCase.expect, "\(testCase.name): the state disagrees")
        }
    }

    func testTonesAndRankMirrorTheSpec() throws {
        // The four tones and their order are data in core/spec/notices.json, and
        // the fixture carries a copy of both so this mirror is proven against the
        // file rather than against another Swift constant.
        let fixture: NoticesFixture = try Fixtures.load("notices")
        XCTAssertEqual(
            Dictionary(uniqueKeysWithValues: NoticeTokens.toneNames.map { ($0, $0) }),
            fixture.tones,
            "the tone names are not the spec's"
        )
        for (tone, rank) in fixture.rank {
            XCTAssertEqual(NoticeTone.rank(tone), rank, "\(tone) should sort at \(rank)")
        }
    }

    func testTheFourTonesSortWorstFirst() throws {
        // Pinned here as well as in the fixtures, because the ordering is what the
        // banner is read by: a failure below a success is a banner someone reads
        // the wrong half of.
        let store = NoticeStore()
        store.set("ok", NoticeRaise(tone: NoticeTone.ok, message: "Connected"))
        store.set("info", NoticeRaise(tone: NoticeTone.info, message: "Downloading"))
        store.set("warn", NoticeRaise(tone: NoticeTone.warn, message: "Shortcut refused"))
        store.set("error", NoticeRaise(tone: NoticeTone.error, message: "Cannot connect"))
        XCTAssertEqual(store.list().map(\.id), ["error", "warn", "info", "ok"])
    }

    func testTheBannerDrawsUnreadAndTheStoreKeepsEverything() throws {
        // The split the desktop relies on as well: the banner is the only surface
        // that filters on read, and everything else wants the full list.
        let store = NoticeStore()
        store.set("connection", NoticeRaise(message: "Cannot connect"))
        XCTAssertEqual(store.unread().map(\.id), ["connection"])
        store.markRead("connection")
        XCTAssertEqual(store.unread().map(\.id), [])
        XCTAssertEqual(store.list().map(\.id), ["connection"])
    }

    // MARK: Applying a fixture

    private func apply(_ op: NoticesFixture.Op, to store: NoticeStore) -> Bool {
        switch op.op {
        case "set":
            guard let id = op.id, let payload = op.notice else {
                XCTFail("a set op with no id or notice: \(op)")
                return false
            }
            // Every field but the message is optional in the fixture, which is
            // what the JS's own defaults are: an omitted tone is the error it
            // raised, and an omitted dismissible is one that can be.
            return store.set(id, NoticeRaise(
                tone: payload.tone ?? NoticeTone.error,
                message: payload.message,
                detail: payload.detail,
                dismissible: payload.dismissible ?? true,
                dismissClears: payload.dismissClears ?? false,
                action: payload.action.map { NoticeAction(label: $0.label, command: $0.command) },
                progress: payload.progress
            ))
        case "markRead":
            guard let id = op.id else { XCTFail("a markRead op with no id"); return false }
            return store.markRead(id)
        case "dismiss":
            // The store's own answer to what a card's X means, which is the rule
            // the download card turns on: a dismissClears notice leaves the store
            // and everything else is read. Pinned by the fixture so both clients
            // agree about which act a closed card performed.
            guard let id = op.id else { XCTFail("a dismiss op with no id"); return false }
            return store.dismiss(id)
        case "markAllRead":
            return store.markAllRead()
        case "clear":
            guard let id = op.id else { XCTFail("a clear op with no id"); return false }
            return store.clear(id)
        default:
            XCTFail("unknown op in the notices fixture: \(op.op)")
            return false
        }
    }

    private func snapshot(_ store: NoticeStore) -> NoticesFixture.Snapshot {
        var notices: [String: NoticesFixture.StoredNotice] = [:]
        for notice in store.list() {
            notices[notice.id] = NoticesFixture.StoredNotice(
                tone: notice.tone,
                message: notice.message,
                detail: notice.detail,
                dismissible: notice.dismissible,
                progress: notice.progress,
                action: notice.action.map { NoticesFixture.Action(label: $0.label, command: $0.command) },
                read: notice.read
            )
        }
        return NoticesFixture.Snapshot(
            size: store.size,
            list: store.list().map(\.id),
            unread: store.unread().map(\.id),
            notice: notices
        )
    }
}

/// `core/fixtures/notices.json`: the tone names and rank, the `sentence()` pairs,
/// and the store cases as a sequence of operations with the return of each and the
/// state at the end.
struct NoticesFixture: Decodable {
    let tones: [String: String]
    let rank: [String: Int]
    let sentence: [Sentence]
    let store: [Case]

    struct Sentence: Decodable {
        let input: String?
        let output: String
    }

    struct Case: Decodable {
        let name: String
        let ops: [Op]
        let returns: [Bool]
        let expect: Snapshot
    }

    struct Op: Decodable, CustomStringConvertible {
        let op: String
        let id: String?
        let notice: Raise?

        var description: String { "\(op) \(id ?? "-")" }
    }

    struct Raise: Decodable {
        let tone: String?
        let message: String
        let detail: String?
        let dismissible: Bool?
        let dismissClears: Bool?
        let progress: Double?
        let action: Action?
    }

    struct Action: Decodable, Equatable {
        let label: String
        let command: String
    }

    struct Snapshot: Decodable, Equatable {
        let size: Int
        let list: [String]
        let unread: [String]
        let notice: [String: StoredNotice]
    }

    struct StoredNotice: Decodable, Equatable {
        let tone: String
        let message: String
        let detail: String?
        let dismissible: Bool
        let progress: Double?
        let action: Action?
        let read: Bool
    }
}

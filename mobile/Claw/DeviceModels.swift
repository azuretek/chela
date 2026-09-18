import Foundation

/// The model name a person recognises, from the hardware identifier the kernel
/// reports.
///
/// iOS publishes no API for this. \`UIDevice.current.model\` is the family
/// ("iPhone"), and the marketing name exists only in Apple's own model list, which
/// is what this table is. BOTH readers take it from here: the About sheet's Device
/// row and the client context an agent is sent, so the name a reader is shown and
/// the name an agent is given cannot drift.
///
/// An identifier with no row reports ITSELF, and that fallback is deliberate twice
/// over. "iPhone18,1" is a true and useful fact on a phone newer than this table,
/// where "unknown" would read as though nobody had checked; and a name assembled
/// out of the identifier's own parts would be a made-up model in the one sheet
/// whose whole job is to be believed. Adding a phone is one line here, and the test
/// beside it requires every row to be a real identifier with a real name.
enum DeviceModels {
    /// The name for an identifier, or the identifier itself when it is newer than
    /// this table. An empty identifier is not a model, so it reads as one nobody
    /// could determine rather than as a blank in a bug report.
    static func marketingName(machine: String) -> String {
        let key = machine.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { return "iOS device" }
        return table[key] ?? key
    }

    /// Apple's identifiers for the iPhones this table knows, and nothing else: no
    /// iPad and no Mac, because this build is iPhone-only and a row nothing can
    /// reach is a row nobody maintains.
    static let table: [String: String] = [
        "iPhone12,1": "iPhone 11",
        "iPhone12,3": "iPhone 11 Pro",
        "iPhone12,5": "iPhone 11 Pro Max",
        "iPhone12,8": "iPhone SE (2nd generation)",
        "iPhone13,1": "iPhone 12 mini",
        "iPhone13,2": "iPhone 12",
        "iPhone13,3": "iPhone 12 Pro",
        "iPhone13,4": "iPhone 12 Pro Max",
        "iPhone14,2": "iPhone 13 Pro",
        "iPhone14,3": "iPhone 13 Pro Max",
        "iPhone14,4": "iPhone 13 mini",
        "iPhone14,5": "iPhone 13",
        "iPhone14,6": "iPhone SE (3rd generation)",
        "iPhone14,7": "iPhone 14",
        "iPhone14,8": "iPhone 14 Plus",
        "iPhone15,2": "iPhone 14 Pro",
        "iPhone15,3": "iPhone 14 Pro Max",
        "iPhone15,4": "iPhone 15",
        "iPhone15,5": "iPhone 15 Plus",
        "iPhone16,1": "iPhone 15 Pro",
        "iPhone16,2": "iPhone 15 Pro Max",
        "iPhone17,1": "iPhone 16 Pro",
        "iPhone17,2": "iPhone 16 Pro Max",
        "iPhone17,3": "iPhone 16",
        "iPhone17,4": "iPhone 16 Plus",
        "iPhone17,5": "iPhone 16e",
    ]
}


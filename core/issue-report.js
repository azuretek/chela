// The opt-out issue report, built and scrubbed in ONE place before it leaves.
//
// The client holds gateway tokens, pairing data and message content. A report
// is an ALLOWLIST of named fields, never a config dump and never a message body,
// and every free-text field is scrubbed and length-capped here. A crash report
// carrying a gateway token is a credential leak that leaves the house, so the
// discipline is allow-list-and-scrub rather than deny-list: an unknown field is
// dropped, not passed through. See core/spec/issue-report.json for the argument.
//
// Electron-free and pure: it takes the facts as an object and returns the report
// to send, so the whole redaction is testable from one run. The desktop owns the
// transport, the queue and the installId's persistence.

import spec from './spec/issue-report.json' with { type: 'json' };

export const ALLOW = spec.allow;
export const FREE_TEXT = spec.freeText;
export const KINDS = spec.kinds;
export const STAGES = spec.stages;
export const CHANNELS = spec.channels;
export const MAX_FIELD_LENGTH = spec.maxFieldLength;
export const COLLECTOR_ENV = spec.collectorEnv;

// Token- and identity-shaped runs, redacted wherever they appear in free text.
// Each is something the client genuinely holds, so each is something an error
// message or a stack could carry by accident.
const REDACTIONS = [
  // Absolute paths with a username: /Users/<name>/..., /home/<name>/..., C:\Users\<name>\...
  [/(?:\/Users\/|\/home\/)[^\s/\\]+(?:[/\\][^\s"']*)?/g, '<path>'],
  [/[A-Za-z]:\\Users\\[^\s\\]+(?:\\[^\s"']*)?/g, '<path>'],
  // Whole URLs: a gateway address is the host, the port and often a token in the
  // query, and the host label alone (my-gateway) is not distinguishable from an
  // ordinary word, so the reliable redaction is the whole URL rather than a guess
  // at the label. Runs before the tailnet and long-run rules so it wins.
  [/\bhttps?:\/\/[^\s"'<>]+/gi, '<url>'],
  [/\bwss?:\/\/[^\s"'<>]+/gi, '<url>'],
  // Bearer tokens and common secret prefixes.
  [/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, 'Bearer <redacted>'],
  [/\bsk-[A-Za-z0-9]{8,}/g, '<redacted>'],
  [/\bxox[baprs]-[A-Za-z0-9-]{8,}/g, '<redacted>'],
  // op:// secret references.
  [/\bop:\/\/[^\s"']+/g, '<redacted>'],
  // JWTs: three base64url runs joined by dots.
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<redacted>'],
  // Tailnet hostnames.
  [/\b[a-z0-9-]+\.ts\.net\b/gi, '<redacted>'],
  // Long base64 or hex runs, which is the shape a gateway token takes. Last, so
  // the more specific rules above win where they overlap. No leading word
  // boundary: a token is often glued to a prefix (gk_, token=), and \\b does not
  // match between an underscore and the run, so the secret would survive.
  [/[A-Za-z0-9+/]{32,}={0,2}/g, '<redacted>'],
  [/[0-9a-fA-F]{32,}/g, '<redacted>'],
];

/**
 * Scrub one free-text value: strip token-shaped and identity-shaped runs, then
 * cap the length. Applied to every free-text field and nothing else, because a
 * structured field (a version, a platform) is not free text and capping it would
 * hide a fault rather than a secret.
 */
export function scrub(value, max = MAX_FIELD_LENGTH) {
  if (typeof value !== 'string') return value;
  let text = value;
  for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement);
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * Build the report to send from whatever facts the client gathered.
 *
 * Allow-list first: only the named fields survive, and an unknown field is
 * dropped rather than carried. Then every free-text field is scrubbed. The
 * result is the exact object that goes on the wire, so a test can assert the
 * emitted field set EQUALS the allowlist and that no forbidden string survives.
 */
export function buildReport(facts = {}) {
  const report = {};
  for (const field of ALLOW) {
    if (facts[field] === undefined || facts[field] === null) continue;
    const value = FREE_TEXT.includes(field) ? scrub(facts[field]) : facts[field];
    report[field] = value;
  }
  return report;
}

/**
 * The keys a report carries, for a test that asserts nothing drifted in. A
 * report never has a key outside the allowlist by construction; this is what
 * proves it.
 */
export function reportKeys(report) {
  return Object.keys(report).sort();
}

/**
 * Whether minidumps are on for this channel BY DEFAULT.
 *
 * dev: on, because dev runs on our own hardware. stable: off, behind a checkbox
 * whose warning names what a dump contains. The reader's explicit opt-in can
 * turn it on for stable; that is the caller's to pass, and this only answers the
 * default.
 */
export function minidumpsOnByDefault(channel) {
  return channel === 'dev';
}

/**
 * The warning a stable-channel minidump checkbox must show, naming the concrete
 * contents of a memory image rather than a vague "may contain sensitive data".
 * A dump cannot be scrubbed, so consent has to be to the real thing.
 */
export function minidumpConsentWarning() {
  return 'A crash dump is a snapshot of the app\'s memory. It can contain the gateway address and hostname, the gateway token, pairing data, message content, and file paths that include your username. It cannot be scrubbed before it is sent. We extract only the crash signature, store that under the same rules as a normal report, and delete the raw dump after a short retention window.';
}

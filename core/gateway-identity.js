// Whether an address is an OpenClaw gateway, asked BEFORE a web view is pointed
// at it.
//
// Answering is not identifying. `Test connection` and the connect path both used
// to ask only whether the address answered, so any 200 passed: a typo that landed
// on a captive portal, a router's admin page, or a different service on the same
// host was put behind the app's chrome and the reader was left to work out for
// themselves that it was not their gateway. This module is the identifying half,
// and it is deliberately pure: it classifies what a client OBSERVED, so the rule
// can be exercised from `node --test` with no network and no server, and so both
// clients can run the same rule over the two different ways they make requests.
//
// ONE OWNER, TWO CLIENTS. The signals and the sentences live in
// spec/gateway-identity.json. The desktop imports this module, which reads that
// file; the iOS client bundles the same file and reads it through
// GatewayIdentity.swift. Neither client types a marker of its own, for the same
// reason the app-settings affordance is one spec rather than one script per
// platform: a product marker copied into two code bases is a marker that is
// right in one of them the day either moves.
//
// What it does and does not do is spelled out in the spec's `why`, and the short
// version is worth repeating here because the shape of this code invites the
// wrong reading. It is a CORRECTNESS boundary: it stops the reader being handed
// an address that is plainly not an OpenClaw payload. It is not a security
// boundary: it authenticates nothing, checks no credential, does not defend
// against a host that deliberately impersonates OpenClaw, and says nothing about
// whether the gateway that answered is the one the reader meant.

import spec from './spec/gateway-identity.json' with { type: 'json' };

/** The one signal that PROVES the payload: OpenClaw's own marker on the served document. */
export const PAYLOAD_ATTRIBUTES = Object.freeze([...spec.payloadAttributes]);

/** The health marker, which SUGGESTS a gateway and proves nothing on its own. */
export const HEALTH_PATH = spec.healthPath;

/** The key the health marker's JSON body must carry as `true`. */
export const HEALTH_OK_KEY = spec.healthOkKey;

/** The security headers, which SUGGEST a deployment's shape and are never required. */
export const HEADER_NAMES = Object.freeze([...spec.headerNames]);

/** How much of a response is read while looking for the marker. */
export const MAX_BYTES = spec.maxBytes;

/** How strong an acceptance was, so a caller can say which rule ran rather than only that one did. */
export const PAYLOAD = 'payload'; // the required signal; the response IS OpenClaw's Control UI
export const CORROBORATED = 'corroborated'; // health marker plus security headers, on a document that is not the shell

/** True when `body` carries any of OpenClaw's own payload markers. */
export function carriesPayloadMarker(body) {
  if (typeof body !== 'string' || body.length === 0) return false;
  const window = body.slice(0, MAX_BYTES);
  // Presence, never a value: a dev build wearing the unsubstituted placeholder
  // is still the Control UI, and a check that read the version would fail a
  // gateway for having moved on.
  return PAYLOAD_ATTRIBUTES.some((name) => window.includes(name));
}

/**
 * The two addresses a client should ask.
 *
 * The document is the CONFIGURED address, unchanged, because it is the address
 * the app would otherwise load and the question is about that exact request: a
 * URL that redirects somewhere else is then judged on where it landed, which is
 * what the reader would have got. The health marker is resolved against the
 * origin ROOT first, where a gateway serves it however it is mounted, and
 * against the configured path's own directory second so a gateway behind a base
 * path is covered either way.
 *
 * Pure string work, and it hands back what it could not resolve as null rather
 * than throwing: a URL the client cannot parse is the caller's to report, and a
 * malformed address has already been refused before this is reached.
 *
 * @param {string} rawUrl the address as configured
 * @returns {{document: string|null, health: string[]}}
 */
export function probeTargets(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { document: null, health: [] };
  }
  const health = [];
  const root = `${url.origin}${HEALTH_PATH}`;
  health.push(root);
  const dir = url.pathname.endsWith('/') ? url.pathname : url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1);
  if (dir && dir !== '/') {
    const underBase = `${url.origin}${dir}${HEALTH_PATH.replace(/^\//, '')}`;
    if (!health.includes(underBase)) health.push(underBase);
  }
  return { document: url.toString(), health };
}

/** Substitute `{name}` placeholders, leaving an unknown one in place rather than printing `undefined`. */
function fill(template, values = {}) {
  return String(template).replace(/\{(\w+)\}/g, (whole, key) => (key in values ? String(values[key]) : whole));
}

/**
 * What an address is, from what a client observed.
 *
 * `observed` is gathered by the client and is deliberately shaped like the
 * answer rather than like a request, so neither this function nor its tests need
 * to know whether the bytes arrived over `http.request` or `URLSession`:
 *
 *   {
 *     document: { status, contentType, body } | null   the configured address
 *     health:   { status, contentType, body } | null   the health marker, or null when not asked
 *     headers:  { [lowercased name]: value }           the document response's headers
 *   }
 *
 * The two accepted paths are named in the result so a caller cannot treat them as
 * one rule: `payload` is the required signal and proves the response is
 * OpenClaw's Control UI, and `corroborated` is the weaker path taken for a
 * deployment that gates its HTML behind a credential, where the health marker and
 * the security headers are all there is to go on.
 *
 * @returns {{ok: boolean, strength: string|null, status: number|null, message: string, evidence: object}}
 */
export function identify(observed = {}) {
  const document = observed.document || null;
  const health = observed.health || null;
  const headers = observed.headers && typeof observed.headers === 'object' ? observed.headers : {};

  const status = document && Number.isFinite(document.status) ? document.status : null;
  const sawDocument = Boolean(document && status !== null);
  const marker = carriesPayloadMarker(document && document.body);
  const headerCount = HEADER_NAMES.filter((name) => String(headers[name] || '').length > 0).length;
  const healthOk = Boolean(
    health
    && health.status === 200
    && /json/i.test(String(health.contentType || ''))
    && healthBodyOk(health.body),
  );

  const evidence = {
    status,
    sawDocument,
    payloadMarker: marker,
    healthOk,
    headersPresent: headerCount,
    headersExpected: HEADER_NAMES.length,
  };

  if (marker) {
    return {
      ok: true,
      strength: PAYLOAD,
      status,
      message: fill(spec.messages.reached, { status: status ?? '?' }),
      evidence,
    };
  }

  // The weaker path, and it is weaker in a way the reader is told about rather
  // than a quiet equivalent: every one of these is claimable, so together they
  // are corroboration and not proof. It still requires the document to be HTML,
  // because the thing being identified is a Control UI page: without that, a
  // JSON API on the same host that happened to carry three common headers and a
  // health marker would be read as a gated gateway.
  const isHtml = /html/i.test(String((document && document.contentType) || ''));
  if (sawDocument && isHtml && status > 0 && status < 500 && headerCount === HEADER_NAMES.length && healthOk) {
    return {
      ok: true,
      strength: CORROBORATED,
      status,
      message: fill(spec.messages.reachedCorroborated, { status }),
      evidence,
    };
  }

  if (!sawDocument) {
    return {
      ok: false,
      strength: null,
      status: null,
      message: fill(spec.messages.notOpenClawNoDocument, {
        reason: observed.error ? fill(spec.messages.unreachable, { reason: observed.error }) : 'It did not answer.',
      }),
      evidence,
    };
  }

  return {
    ok: false,
    strength: null,
    status,
    message: fill(spec.messages.notOpenClaw, { status: status ?? '?' }),
    evidence,
  };
}

/** Whether a health body is the marker rather than merely JSON. */
function healthBodyOk(body) {
  if (typeof body !== 'string' || body.length === 0) return false;
  try {
    const parsed = JSON.parse(body);
    return Boolean(parsed) && parsed[HEALTH_OK_KEY] === true;
  } catch {
    return false;
  }
}

/** Every sentence this module can produce, for a test that holds them all to the spec. */
export const MESSAGES = Object.freeze({ ...spec.messages });

export default spec;

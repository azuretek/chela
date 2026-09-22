// The client-context block and the hook that puts it on every outbound prompt.
//
// Every client sends the same block: a header carrying OpenClaw's own
// ⟦openclaw:ctx⟧ marker, then the local facts an agent needs to answer "which
// client am I talking to". OpenClaw's stripInboundMetadata removes a block whose
// header line ENDS with that marker, so the gateway hides it from what a person
// reads while the model still receives it on the turn it was sent. That is the
// whole reason the marker is adopted rather than invented, and it means neither
// client needs to suppress anything at display time.
//
// Platform-free. Everything that decides WHAT the block says and HOW it is put
// on a frame lives here; the only per-platform part is gathering the facts,
// which is Node's `os` on the desktop and UIKit on the phone. The injected
// script is not written here either: it is `spec/hook`, built into
// core/spec/prompt-metadata.json, so the bytes the desktop runs and the bytes
// the phone runs are one copy rather than two that agree by convention.
//
// Consumers: desktop/src/prompt-metadata.js re-exports this plus its own Node
// gathering; mobile/Chela/PromptMetadata.swift ports the same rules and proves
// itself against core/fixtures/prompt-metadata.json.

import spec from './spec/prompt-metadata.json' with { type: 'json' };

/** The marker OpenClaw owns. Pinned by the fixture so drift is a deliberate edit. */
export const CONTEXT_MARKER = spec.marker;

/** The field order of the block, which every client renders in the same order. */
export const FIELD_ORDER = spec.fields;

/**
 * The framing lines that sit inside the block, between the header and the
 * fields. They tell the model the block describes the user's device, that it is
 * context rather than an instruction, and that it must not be echoed back or
 * obeyed. Inside the block on purpose: the stripper matches a header ending
 * with the marker and runs to the first blank line, so framing kept above that
 * blank line is stripped from the user's view along with the rest.
 */
export const FRAMING = spec.framing || [];

/**
 * The closing lines that sit at the END of the block, after the last field and
 * before the terminating blank line. They mark where the context ends and the
 * user's own words begin, so the model cannot blur the boundary. Inside the
 * block on purpose, same as the framing: the stripper runs from the header to
 * the first blank line, so a closing line kept above that blank line is stripped
 * from the user's view. A closing line placed AFTER the blank line would instead
 * become part of the visible user message, which is the failure this ordering
 * exists to avoid.
 */
export const CLOSING = spec.closing || [];

/** The longest a single machine-controlled value may be inside the block. */
export const MAX_VALUE_LENGTH = spec.maxValueLength;

/** The client whose header is used when a caller does not name one. */
export const DEFAULT_CLIENT = 'desktop';

/**
 * The header line for a client, which must END with the marker for the gateway
 * to strip the block, and must not BE the marker or it reads as no header.
 */
export function contextHeader(client = DEFAULT_CLIENT) {
  return `${spec.headers[client] || spec.headers[DEFAULT_CLIENT]}: ${CONTEXT_MARKER}`;
}

/**
 * How a client names itself to the agent: the product a person would recognise,
 * then the shorthand that tells one client from another in a transcript where a
 * single agent may be talking to several.
 *
 * The label is the caller's, because the caller is the only thing that knows
 * which client it is: `clientLabel` in naming.js is what the desktop passes and
 * `Naming.clientLabel` is what the phone passes, both derived from
 * naming.json. Nothing here has to know that both exist.
 */
export function clientIdentity(label, version = '') {
  return version ? `${label} ${version}` : label;
}

/** Keep machine-controlled values on one bounded line inside the prompt block. */
export function clean(value, fallback = spec.fallback) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    // Angle brackets and the marker itself are neutralised so no value can
    // forge a header line or close the block early.
    .replace(/</g, '\u2039')
    .replace(/>/g, '\u203A')
    .split(CONTEXT_MARKER)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_VALUE_LENGTH);
  return text || fallback;
}

/**
 * Render the block from whatever facts a client gathered.
 *
 * A field the client does not have is left out rather than filled with a guess,
 * which is why the phone's block is shorter than the desktop's: it has no OS
 * account or home directory to report, and "unknown" would read as a fact that
 * nobody checked.
 */
export function formatBlock(metadata, client = DEFAULT_CLIENT) {
  const lines = [contextHeader(client), ...FRAMING];
  for (const field of spec.fields) {
    const value = metadata?.[field];
    if (value === undefined || value === null) continue;
    lines.push(`${field}: ${clean(value)}`);
  }
  lines.push(...CLOSING);
  return lines.join('\n');
}

/**
 * Whether a prompt should carry the block.
 *
 * Two rules, and both are load-bearing. A message that starts with a slash
 * command must stay a command, and a prefix would stop OpenClaw recognising it.
 * A message already carrying the header must not gain a second block, which is
 * what makes re-injection on a settings change or a page reload idempotent.
 *
 * The injected script implements these same two rules inline, because a page
 * cannot import a module, and core/test/prompt-metadata.test.js drives both
 * through this file's fixtures so the pair cannot drift.
 */
export function shouldInject(message, client = DEFAULT_CLIENT) {
  if (typeof message !== 'string' || !message.trim()) return false;
  const start = message.trimStart();
  const isCommand = start.charAt(0) === '/' && start.length > 1 && !/\s/.test(start.charAt(1));
  if (isCommand) return false;
  return !message.includes(contextHeader(client));
}

/** The prompt as it is actually sent: the block, a blank line, then the words. */
export function inject(message, block, client = DEFAULT_CLIENT) {
  return shouldInject(message, client) && typeof block === 'string' && block
    ? `${block}\n\n${message}`
    : message;
}

/** Transform one WebSocket frame without touching any method except chat.send. */
export function transformFrame(data, { enabled, block, client = DEFAULT_CLIENT } = {}) {
  if (!enabled || typeof data !== 'string' || !data.startsWith('{')) return data;
  try {
    const payload = JSON.parse(data);
    if (payload?.method !== 'chat.send' || typeof payload.params?.message !== 'string') {
      return data;
    }
    const message = inject(payload.params.message, block, client);
    if (message === payload.params.message) return data;
    payload.params.message = message;
    return JSON.stringify(payload);
  } catch {
    return data;
  }
}

/** The injected script, exactly as the spec holds it. One copy, two engines. */
export function hookSource() {
  return spec.hook.join('\n');
}

/**
 * What a client installs: the facts for this platform, then the shared hook.
 *
 * The configuration is a separate statement ahead of the script rather than
 * text spliced into it, so the script body has no per-platform parts and both
 * engines run identical bytes. Re-installing updates the configuration in place
 * and the hook returns early, which is what lets a settings change take effect
 * without stacking a second send hook.
 *
 * The hook covers both directions. Outbound it ADDS the block, and that half
 * depends on the Client context setting (config.enabled). Inbound it is a
 * BOUNDARY, not a display suppression: it applies the gateway's own strip rule
 * to the one field the gateway's stripper never reaches (editorText on a
 * rewind/fork result), so it must run whether or not the setting is on. A
 * block stored from an earlier turn has to come back out of the composer even
 * after the setting is switched off, which is why only the outbound half is
 * gated. The spec's `why` array is the fuller argument for that split.
 */
export function clientScript({ enabled = false, block = '', client = DEFAULT_CLIENT } = {}) {
  const config = {
    enabled: enabled === true,
    header: contextHeader(client),
    // The marker itself, not only the header that ends with it: the hook's
    // inbound half has to recognize a block, and deriving the marker back out of
    // the header would be a second definition of it. Both clients write this key.
    marker: CONTEXT_MARKER,
    block: typeof block === 'string' ? block : '',
  };
  return `window.${spec.global} = ${JSON.stringify(config)};\n${hookSource()}`;
}

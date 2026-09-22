// What this product and its clients are called, read from spec/naming.json.
//
// Every user-visible name and every identifier that a rename must not move comes
// from here: the product name the desktop shows, the per-client shorthand in an
// artifact or a workflow name, the prompt-metadata client string, the repo the
// app sends people to for releases, the profile directory a migration moves, and
// the Keychain item that has to stay where it is. The alternative was the same
// string written into twenty files, which is what the previous rename cost and
// what this module exists to stop.
//
// Platform-free, and deliberately so: it derives strings and nothing else, so it
// loads under `node --test`, in the packaged app, and in a script. Which plane
// consumes it where is the whole design, and the reason there is a test beside
// it rather than only this file:
//
//   desktop/src/*.js        imports this module, for anything a person reads
//   desktop/test/           asserts the surfaces that cannot import it at all
//   mobile/Chela/Naming.swift mirrors it, and mobile/ChelaTests proves the mirror
//
// The one thing it is not: an environment variable, or anything else that can
// differ between two launches or two builds of one commit. `productName` decides
// where Electron keeps userData and which Keychain item safeStorage opens, so a
// name that varies per environment would split a profile or orphan the
// credentials in it. The spec's own `why` records that at length.

import spec from './spec/naming.json' with { type: 'json' };

/** What a person calls this product. The only spelling of it in the repo. */
export const product = spec.product;

/** `owner/name`, the slug every URL and `gh` invocation is built from. */
export const repo = `${spec.repo.owner}/${spec.repo.name}`;

export const repoUrl = `https://github.com/${repo}`;

/** Where a build that cannot update itself sends someone (see src/main.js). */
export const releasesUrl = `${repoUrl}/releases`;

/**
 * The clients, by shorthand. `shorthand` is what identifies one where two
 * clients could be confused: artifact names, workflow names, log prefixes, the
 * client string in prompt metadata, a User-Agent token.
 */
export const desktop = spec.clients.desktop;
export const mobile = spec.clients.mobile;

/**
 * How a client names itself where a person and a machine both read it. The
 * product name is what makes it recognisable in a transcript; the shorthand is
 * what tells the desktop apart from the phone in the same one.
 */
export const clientLabel = {
  desktop: `${product} (${desktop.shorthand})`,
  mobile: `${product} (${mobile.shorthand})`,
};

/** Product names this one replaced, for the sweep in test/naming.test.js. */
export const retired = spec.retired.products;

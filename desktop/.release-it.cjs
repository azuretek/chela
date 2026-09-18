'use strict';

// Release configuration, driven by release-it.
//
//   npm run release              # patch: 1.0.0 -> 1.0.1
//   npm run release -- minor
//   npm run release -- major
//   npm run release -- --dry-run
//
// release-it replaced a hand-written script that did the same four steps. The
// steps were never the hard part -- the preflight is, and a maintained tool has
// years of other people's mistakes encoded in its checks.
//
// Why not semantic-release or release-please: both decide the VERSION by parsing
// Conventional Commits, and that decision is the one kept human here. The repo
// does write those commits, the release notes group merged pull requests by
// them, and that is the reason to refuse the version parse rather than a reason
// to adopt it: whether a change earns a minor or a patch is a judgement about what is
// shipping. The older half of the history is the other reason: of its first 27
// subjects, 1 parsed. release-it asks for the bump instead, which is the honest
// interface.
//
// A CommonJS config rather than .release-it.json so the reasoning above can live
// with the settings; package.json declares no `type`, so `.cjs` is explicit.

const fs = require('node:fs');
const path = require('node:path');

// The repo this releases into, from the one owner (core/spec/naming.json).
// Read rather than written down: a slug that lives in two files is a slug that
// sends someone to a 404 the day one of them moves. This config is CommonJS
// while core/naming.js is ESM, so it parses the spec itself.
const naming = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'core', 'spec', 'naming.json'), 'utf8'),
);
const REPO = `https://github.com/${naming.repo.owner}/${naming.repo.name}`;

module.exports = {
  git: {
    // Releases are cut from main so the tag lands on the line everyone builds.
    requireBranch: 'main',
    // Untracked files count as dirty here, and should: they are inside `src/**`
    // for packaging purposes, so they can change what ships while leaving the
    // commit looking clean.
    requireCleanWorkingDir: true,
    // CI builds the remote, not this checkout. Releasing from a branch that has
    // no upstream produces a tag nothing will build.
    requireUpstream: true,
    commitMessage: 'Release v${version}',
    tagName: 'v${version}',
    tagAnnotation: 'Claw Control UI v${version}',
    push: true,
  },

  github: {
    // The GitHub Release is created by CI, not from here.
    //
    // It has to be: electron-builder generates `latest.yml` / `latest-mac.yml`
    // during the build, and those files are what an updater reads. A release
    // created here would exist before those files do, and two publishers
    // writing one release is how assets go missing from it.
    release: false,
  },

  npm: {
    // Not a package. This still bumps package.json and package-lock.json --
    // that is the npm plugin's bump step, not publication.
    publish: false,
  },

  hooks: {
    // Nothing is written until these pass. A release that stops before the
    // first write is recoverable; one that stops after tagging leaves a tag
    // only on this machine, which is the state that later produces "why did CI
    // build the wrong commit".
    'before:init': ['npm test'],
    'after:release': [
      `echo "\n  released \${name} v\${version}"`,
      `echo "  CI is building it:  ${REPO}/actions"`,
      `echo "  installers land at: ${REPO}/releases/tag/v\${version}\n"`,
    ],
  },
};

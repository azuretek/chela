import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(HERE, '..', 'scripts');

// Comments describe the anti-pattern, so they must not count as using it.
// `(^|[^:])` keeps the `//` inside a `file://` or `https://` string from being
// mistaken for the start of a comment.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// A script that can also be imported has to know whether it is the entry point.
// The obvious form, concatenating "file://" with process.argv[1], is POSIX-only,
// and it shipped once: on Windows argv[1] is a backslash path
// (`D:\a\claw\desktop\scripts\build.js`), the two strings never matched, main()
// silently never ran, and `npm run build:win` exited 0 having built nothing. The
// only symptom was a missing dist/ two steps later in CI, which read as a smoke
// failure rather than a build one.
test('the entry guard is platform-correct, not a string prefix', () => {
  for (const name of ['build.js', 'build-version.js', 'build-info.js']) {
    const code = stripComments(readFileSync(path.join(SCRIPTS, name), 'utf8'));
    assert.doesNotMatch(
      code,
      /file:\/\/\$\{process\.argv\[1\]\}/,
      `${name} uses the POSIX-only entry guard`,
    );
    assert.match(
      code,
      /pathToFileURL\(process\.argv\[1\]\)/,
      `${name} should compare import.meta.url against pathToFileURL(process.argv[1])`,
    );
  }
});

test('the naive concatenation is not the real module URL form', () => {
  // The reason the guard above exists, asserted rather than described. A Windows
  // path never equals "file://" + itself, which is what made the build a no-op.
  const winPath = 'D:\\a\\claw\\desktop\\scripts\\build.js';
  assert.notEqual(`file://${winPath}`, pathToFileURL(winPath).href);
});

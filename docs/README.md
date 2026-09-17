# Documentation

Shared documentation for Claw Control UI. This is one project with three trees,
not three projects that live together, so everything that is true of more than
one interface is written once here.

| Document | Answers |
|---|---|
| [layout.md](layout.md) | How the trees are arranged, what belongs in `core/` and what belongs to an interface, and where shared tooling lives. |
| [release.md](release.md) | What a release is, what it must carry, how a build is versioned, and how each interface distributes it. |
| [testing.md](testing.md) | What runs where: the unit suites, the parity fixtures, the local push gate, and what CI cannot check. |

Interface-specific documentation stays with its interface:
`core/README.md` for the shared rules themselves, `desktop/README.md`
for using and building the desktop app, `mobile/README.md` for the iOS
client.

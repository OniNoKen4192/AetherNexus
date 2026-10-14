# Aether Nexus

Aether Nexus is an always-on dispatch layer that turns features and bug
reports into routed, reviewed, merged work across model providers. Each
task goes to the cheapest model that can do it correctly - frontier
judgment for planning and review, delegated muscle for well-bounded
implementation - and nothing lands without an independent review, a scope
audit, and a human-controlled merge. It is a fork of
[Lanes](https://github.com/OniNoKen4192/Lanes) and is being rebuilt as a
local server plus CLI around a SQLite event log.

## Status: v0 skeleton

**Works end to end with the fake adapter** (deterministic scripted
agents, no network, no spend):

```
nexus init
nexus system create <slug> --title <t> --brief-text <text>
nexus planet assign <system-id> --stream <id> --territory <glob>
nexus moon assign <planet-id> <spec-path>
nexus moon launch <task-id> --provider fake
nexus voyage inspect <task-id> --provider fake
nexus voyage dock <task-id>
```

Spec gate, scope audit, transition table, event log, projections,
`db rebuild`, and the git model (planet branches, moon worktrees, merge on
dock, never push) are all covered by the test suite.

**Stretch, not required for v0:** the real adapters (`claude-sdk`,
`codex-mcp`) are implemented and exercised only by the opt-in live tests:
`NEXUS_LIVE=1 npm test -- "tests/live/*.test.mjs"` (spends your pool).

**Not yet ported:** `commands/`, `agents/`, `skills/` and `templates/` are
still the Lanes plugin surface and are replaced in later phases.

Design docs: [`docs/2026-10-10-aether-nexus-design.md`](docs/2026-10-10-aether-nexus-design.md)
and [`docs/superpowers/specs/2026-10-13-v0-skeleton-design.md`](docs/superpowers/specs/2026-10-13-v0-skeleton-design.md).

```
npm install
npm test                          # builds, then runs the full suite
node dist/cli/main.js --help
```

The [User Guide](docs/USER-GUIDE.md) still describes the Lanes plugin the
fork started from.

## License

MIT - see [LICENSE](LICENSE).

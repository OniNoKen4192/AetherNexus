# Aether Nexus

Aether Nexus is an always-on dispatch layer that turns features and bug
reports into routed, reviewed, merged work across model providers. Each
task goes to the cheapest model that can do it correctly - frontier
judgment for planning and review, delegated muscle for well-bounded
implementation - and nothing lands without an independent review, a scope
audit, and a human-controlled merge. It is a fork of
[Lanes](https://github.com/OniNoKen4192/Lanes) and is being rebuilt as a
local server plus CLI around a SQLite event log.

## Status: v0.5 Bridge

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

**The Bridge (v0.5)** is the same lifecycle in a browser:

```
nexus serve [--port <n>]          # 127.0.0.1 only, default port 7341, until Ctrl-C
```

`serve` prints a URL carrying an access token for that run; open it and
the page sets its cookie. From the page you can create a system, assign
streams and specs, launch, inspect, dock, reply to or drop a parked moon,
cancel a voyage, answer a main-tree question, retire a ship and reorder
which provider is tried first. The server runs voyages concurrently
(`scheduler.max_concurrent_ships`), and the page follows the event log
live, so CLI commands run in another terminal show up without a reload.
Two CLI additions support it: `nexus events --follow` tails the log, and
`nexus decision answer <id> --mine | --not-mine` answers the question the
server asks when the main working tree changes during a voyage.

Known limitations of v0.5:

- The access cookie is bound to the host `127.0.0.1`, not to the port
  (browsers do not scope cookies by port), so the browser also sends it to
  any other web server you run on `127.0.0.1`. Requests from another
  origin are refused and every `GET /api/*` is read-only, but do not run
  software you do not trust on a local port while the Bridge is open.
  Restarting `nexus serve` issues a new token.
- The `nexus status` table does not list pending decisions; the Bridge
  and `nexus --json status` do.
- No fuel gauge, limiter or rung selector yet; those are planned for v1.

**Stretch, not required for v0:** the real adapters (`claude-sdk`,
`codex-mcp`) are implemented and exercised only by the opt-in live tests:
`NEXUS_LIVE=1 npm test -- "tests/live/*.test.mjs"` (spends your pool).

**Not yet ported:** `commands/`, `agents/`, `skills/` and `templates/` are
still the Lanes plugin surface and are replaced in later phases.

Design docs: [`docs/2026-10-10-aether-nexus-design.md`](docs/2026-10-10-aether-nexus-design.md),
[`docs/superpowers/specs/2026-10-13-v0-skeleton-design.md`](docs/superpowers/specs/2026-10-13-v0-skeleton-design.md)
and [`docs/superpowers/specs/2026-11-13-v0.5-bridge-design.md`](docs/superpowers/specs/2026-11-13-v0.5-bridge-design.md).

```
npm install
npm run build                     # tsc to dist/, then the Bridge page (web/) to dist/web
npm test                          # builds, then runs the full suite
node dist/cli/main.js --help
```

The [User Guide](docs/USER-GUIDE.md) still describes the Lanes plugin the
fork started from.

## License

MIT - see [LICENSE](LICENSE).

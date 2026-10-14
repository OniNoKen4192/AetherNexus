NEXUS-SPEC: {{spec_path}}
NEXUS-WORKTREE: {{worktree}}

You are implementing a single scoped task. The spec below is your
complete contract. Follow it literally. Do not modify any file not
listed under "Touch". Do not add features, options, refactors, or
documentation beyond the spec. Never run any git command that
writes — no commit, branch, checkout, merge, rebase, reset, stash,
or tag. Leave every change uncommitted in the working tree; the
controller owns git state. When done, run the Acceptance test
command and include its output. If the spec is impossible to
satisfy as written, stop and explain instead of improvising.

{{spec_text}}
{{delta_section}}
## Report Format
Return exactly this structure:

STATUS: IMPLEMENTED | IMPLEMENTED_WITH_DEVIATIONS | BLOCKED | BACKEND_FAILURE | RATE_LIMITED
FILES_CHANGED: <list with one-line summary each>
TEST_OUTPUT: <last 20 lines of the acceptance command>
DEVIATIONS: <anything done differently than specified, and why — or "none".
  IMPLEMENTED requires "none"; IMPLEMENTED_WITH_DEVIATIONS requires a
  non-empty list>
BLOCKED_REASON: <only if BLOCKED: what was needed that the spec didn't provide>

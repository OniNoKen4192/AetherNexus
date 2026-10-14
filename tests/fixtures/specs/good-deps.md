# TASK: thing-add-x
## Meta
- **Task ID**: T1
- **Parent plan**: docs/plans/p.md
- **Depends on**: T0, T0b
- **Gravity**: 7
- **Estimated scope**: S
- **Model hint**: terra

## Objective
Add X to thing.

## Files

### Touch
| Path | Action | Notes |
|------|--------|-------|
| `src/lib/thing.js` | modify | add X |
| `src/lib/thing.test.js` | create | acceptance |

### Do NOT touch
- everything else

## Acceptance
**Test command (must exit 0):**
```bash
node run-tests.mjs
```

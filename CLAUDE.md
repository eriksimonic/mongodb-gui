# Mongo GUI

## Plans

When a plan is complete, convert it into a section of `docs/implementation-notes.md` and delete the
plan files. Keep only decisions, constraints and gotchas the code does not show. Move anything still
open into "Open work" in `docs/architecture.md`. Do not leave finished plans, status files or
baselines in the repo; git history keeps them.

## Docs screenshots

`docs/screenshots` holds exactly six pinned screenshots. Do not add others.

| File              | Shows                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| `query.png`       | Editor tab on Local dev, shop, after `db.orders.find({})`, Table view                                        |
| `explain.png`     | Explain tab for the `orders` aggregate with `$lookup`, `$group`, `$sort`                                     |
| `profiler.png`    | Profiler of the shop database, Slow queries tab                                                              |
| `diagnostics.png` | Diagnostics of Local dev, Logs tab                                                                           |
| `sql.png`         | SQL tab on Local dev, shop, a join with GROUP BY, HAVING and ORDER BY, with the translated mongosh beside it |
| `monitoring.png`  | Monitoring dashboard of Local dev, with the panels filled with data                                          |

- Refresh them when the UI they show changes, from the browser mock UI at 1536x1024 in the dark
  theme. `.claude/skills/run-app/SKILL.md` has the launch steps and selectors.
- Hand the capture to a subagent on the Haiku model, and look at each image before you keep it.
- Tests and scripts write their images to `e2e/output`, never to `docs/screenshots`.

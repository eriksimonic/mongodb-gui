# Mongo GUI

## Docs screenshots

`docs/screenshots` holds exactly four pinned screenshots. Do not add others.

| File              | Shows                                                                 |
| ----------------- | --------------------------------------------------------------------- |
| `query.png`       | Editor tab on Local dev, shop, after `db.orders.find({})`, Table view |
| `explain.png`     | Explain tab for `db.orders.find({ status: 'paid' })`                  |
| `profiler.png`    | Profiler of the shop database, Slow queries tab                       |
| `diagnostics.png` | Diagnostics of Local dev, Logs tab                                    |

- Refresh them when the UI they show changes, from the browser mock UI at 1280x800 in the dark
  theme. `.claude/skills/run-app/SKILL.md` has the launch steps and selectors.
- Hand the capture to a subagent on the Haiku model, and look at each image before you keep it.
- Tests and scripts write their images to `e2e/output`, never to `docs/screenshots`.

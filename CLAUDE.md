# Mongo GUI

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

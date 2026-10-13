# Explain lab

A single MongoDB 8.0.17 server with data and queries that give large explain plans: `SORT_MERGE`
with up to seven index scans, nested `$lookup`, `$facet`, `$unionWith` and `$graphLookup`. Use it
to check the Explain tab against a real server.

## Start it

```sh
bash up.sh
```

The script starts the container `mongo-gui-explain-lab` on `127.0.0.1:27218`, without auth, and
seeds the database `explain_lab`. The seed drops the database first and uses a fixed random seed,
so every run gives the same data. Connect the app to:

```
mongodb://127.0.0.1:27218/explain_lab
```

## Data

| Collection   | Documents | Indexes                                                                                     |
| ------------ | --------- | ------------------------------------------------------------------------------------------- |
| `orders`     | 60,000    | `{status, createdAt}`, `{channel, createdAt}`, `{customerId, createdAt}`, `items.productId` |
| `customers`  | 5,000     | `email` (unique), `{country, tier}`                                                         |
| `products`   | 2,000     | `sku` (unique), `categoryId`                                                                |
| `categories` | 160       | `parentId`. Four trees, four levels deep                                                    |
| `reviews`    | 20,000    | `{productId, rating}`. No index on `customerId`                                             |
| `shipments`  | 40,000    | `orderId`                                                                                   |

## Queries

`queries.js` holds one statement per `// case:` block. In a dev build (`pnpm dev` or
`pnpm dev:ui`) the editor toolbar has a "Lab query" dropdown. Picking a case puts its statement in
the editor and switches the tab to `explain_lab`. Then press Explain. The dropdown is temporary and
does not show in a production build.

In the mock UI a lab statement explains with the plan captured from this server, whatever database
the tab is on.

## Refresh the fixtures

After you change `seed.js` or `queries.js`, run `bash up.sh`, then:

```sh
bash capture.sh
```

It writes `packages/core/src/explain/fixtures/lab/<case>.executionStats.json`. Update the `lab/`
rows in `packages/core/src/explain/normalise.fixtures.test.ts` to match.

## Stop it

`docker rm -f mongo-gui-explain-lab && docker volume rm mongo-gui-explain-lab`

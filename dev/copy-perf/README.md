# Copy performance fixture

Two standalone MongoDB 8.0.17 servers for testing the copy feature at speed. Server A holds
`shop.events` with 1,000,000 documents and `shop.customers` with 10,000. Server B starts empty.
Both servers keep their data in RAM (tmpfs), with no CPU or memory limits.

The compose project is `mongo-gui-copyperf`. It does not touch the replica set fixture in
`dev/replica-set`.

## Start it

1. Run this from the repo root:

   ```sh
   bash dev/copy-perf/up.sh
   ```

2. Check that both servers are healthy:

   ```sh
   docker ps --filter name=mongo-gui-copyperf
   ```

   Both containers show `(healthy)`.

The script waits for both servers, then seeds server A. Run it again to skip the seed. Add
`--force` to seed again: `bash dev/copy-perf/up.sh --force`.

## Connection URIs

- Server A, the source: `mongodb://127.0.0.1:27217/`
- Server B, the target: `mongodb://127.0.0.1:27218/`

There is no user and no password. Each port is bound to 127.0.0.1 only.

## Seed numbers

The seed runs on this machine (32 cores, 61 GB RAM, NVMe). Each run drops and seeds
`shop.events` and `shop.customers`, then builds the two indexes. Index times are about 1.5 s each.

| Batch size | Concurrency | Run 1 docs per second | Run 2 docs per second |
| ---------- | ----------- | --------------------- | --------------------- |
| 10,000     | 16          | 648,256               | 642,396               |
| 5,000      | 24          | 657,515 (kept)        | 648,993               |
| 20,000     | 8           | 634,393               | 637,826               |

The kept setting is batch 5,000 and concurrency 24, the defaults in `seed.mjs`. Total seed time is
about 3 s. The differences between settings are within run-to-run noise.

Average document size is 169 bytes. The `shop.events` data is 169 MB.

## Copy in the app

1. Add server A as a connection named `mongo-a`, with the URI above.
2. Add server B as a connection named `mongo-b`, with the URI above.
3. In the sidebar, right-click `shop.events` on `mongo-a`.
4. Choose Import and export, then Copy to.
5. Set the target connection to `mongo-b` and the target database to `shop`.
6. Pick a mode (replace, merge or insert only) and start the copy.

## Perf test

The test runs the real copy service with the same two servers. It runs four copies of
`shop.events` from A to B. The first two are replace copies, one into an empty target and one over
the copy that exists. The third is a merge, and the fourth is an insert only copy where every
document already exists.

Run it from the repo root. The test needs the bundled mongo tools in `packages/app/resources`.

```sh
COPY_PERF=1 pnpm exec vitest run --project integration packages/app/src/main/copy/copy.perf.integration.test.ts
```

The test prints one line per copy with the wall time, documents per second, and the peak RSS of
the test process. It fails when the servers are unreachable or when `shop.events` on A has fewer
than 1,000,000 documents. Without `COPY_PERF=1`, the test is skipped.

The copy numbers from the last run on this machine:

| Copy                     | Seconds | Docs per second | Peak RSS |
| ------------------------ | ------- | --------------- | -------- |
| Replace, new target      | 6.2     | 160,401         | 197 MB   |
| Replace, existing target | 6.2     | 162,050         | 166 MB   |
| Merge, full target       | 9.9     | 100,634         | 815 MB   |
| Insert only, full target | 23.3    | 42,901          | 808 MB   |

The peak RSS covers the test process only. It does not include the mongodump and mongorestore
processes, and it is sampled every 100 ms.

## Stop it

Run this from the repo root. It deletes the data, so the next `up.sh` seeds again.

```sh
bash dev/copy-perf/down.sh
```

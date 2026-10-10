# Replica set test fixture

This fixture runs a three-member MongoDB 7.0 replica set (`rs0`) in Docker Compose. The Mongo GUI uses it to test against a realistic cluster. On first start it seeds `perf.events` with 1,000,000 documents for query and performance checks.

The compose project is named `mongo-gui-perf`, so its containers, networks, and volumes do not clash with other Compose projects.

## Start it

Run this from this directory:

```sh
bash up.sh
```

The script starts the containers, initiates the replica set, creates the admin user, seeds the data, and prints the connection URIs. The seed takes several minutes under the CPU limit. Rerunning `up.sh` is safe. It skips the steps that are already done and inserts only the missing documents.

## Connection URIs

The admin user is `admin` with password `admin`, and the role is `root` on the `admin` database.

Connect to one member directly. The app shows the connection as "direct":

```
mongodb://admin:admin@127.0.0.1:27117/?directConnection=true&authSource=admin
```

Connect to the full replica set. The driver discovers all three members and follows the primary. This URI needs one line in `/etc/hosts`, because the members advertise themselves as `rs1`, `rs2`, and `rs3`:

```
127.0.0.1 rs1 rs2 rs3
```

Add that line with `sudo` and an editor, or run `echo "127.0.0.1 rs1 rs2 rs3" | sudo tee -a /etc/hosts`. Then use:

```
mongodb://admin:admin@127.0.0.1:27117,127.0.0.1:27118,127.0.0.1:27119/?replicaSet=rs0&authSource=admin
```

The members listen on ports 27117, 27118, and 27119. Each port is bound to 127.0.0.1 only, so the fixture is not reachable from other machines.

## Resource limits

Each member has a CPU limit of 0.5 cores and a memory limit of 512 MB. The WiredTiger cache is capped at 0.25 GB because of the 512 MB memory limit. A larger cache can push the process past the limit, and the kernel then kills it.

Internal authentication uses a keyfile. The `keyfile` service writes it to a shared volume once, and the members read it from there.

## Seed data

The `perf.events` collection holds 1,000,000 documents with these fields: `userId`, `type`, `amount`, `tags`, `createdAt`, and `meta`. The seed creates indexes on `{ userId: 1 }` and `{ createdAt: -1 }`.

To load the seed by hand, run `docker compose exec rs1 bash /scripts/seed.sh`.

## Tear down

Run this from this directory:

```sh
bash down.sh
```

The script runs `docker compose down -v`. It stops the containers and deletes the named volumes of this project, so the next `up.sh` starts from empty data.

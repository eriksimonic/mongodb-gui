#!/usr/bin/env bash
# Starts a single mongod 7.0 on 127.0.0.1:27219 (no auth) with 500 databases of 100 collections each,
# split over five application profiles (shop, crm, cms, iot, logistics) for catalog and tree performance checks.
# Seeding creates 50,000 collections and takes a while. Rerunning skips databases that are complete.
set -euo pipefail
# Each collection and its _id index is a file, so mongod needs a high open-file limit (set on docker run below).
cd "$(dirname "$0")"
docker start mongo-gui-many 2>/dev/null || docker run -d --name mongo-gui-many --ulimit nofile=1048576:1048576 -p 127.0.0.1:27219:27017 -v mongo-gui-many:/data/db mongo:7.0 --wiredTigerCacheSizeGB 2 >/dev/null
until docker exec mongo-gui-many mongosh --quiet --eval 'db.adminCommand("ping").ok' >/dev/null 2>&1; do sleep 1; done
docker cp seed.js mongo-gui-many:/tmp/seed.js
for app in shop crm cms iot logistics; do
  docker exec -d mongo-gui-many mongosh --quiet --eval "var APP='$app'" --file /tmp/seed.js
done
echo "Seeding runs in the container. Count databases with:"
echo "  docker exec mongo-gui-many mongosh --quiet --eval 'db.adminCommand({listDatabases:1,nameOnly:true}).databases.length'"
echo "mongodb://127.0.0.1:27219/"

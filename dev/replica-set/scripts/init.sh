#!/bin/bash
# Runs inside the rs1 container: docker compose exec rs1 bash /scripts/init.sh
# Initiates rs0 and creates the admin user. The localhost exception lets this
# run without credentials, so every step connects over localhost only.
# The script is idempotent and safe to retry.
set -euo pipefail

PORT=27117
LOCAL="mongodb://localhost:${PORT}/?directConnection=true"
AUTH="mongodb://admin:admin@localhost:${PORT}/?directConnection=true&authSource=admin"

wait_for() {
  # Retries the command in $1 for up to 120 seconds.
  for _ in $(seq 1 60); do
    if eval "$1" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  echo "Timed out waiting for: $2" >&2
  return 1
}

echo "Waiting for mongod on port ${PORT}"
wait_for "mongosh --quiet '$LOCAL' --eval 'db.adminCommand({ping: 1})'" "mongod on port ${PORT}"

initiated=$(mongosh --quiet "$LOCAL" --eval 'print(db.hello().setName === "rs0" ? "yes" : "no")' 2>/dev/null || echo no)
if [ "$initiated" != "yes" ]; then
  echo "Initiating replica set rs0"
  # rs1 gets priority 2 so it wins the election. The localhost exception only
  # applies to a connection from rs1 itself, so user creation must hit rs1.
  mongosh --quiet "$LOCAL" --eval '
    rs.initiate({
      _id: "rs0",
      members: [
        { _id: 0, host: "rs1:27117", priority: 2 },
        { _id: 1, host: "rs2:27118" },
        { _id: 2, host: "rs3:27119" }
      ]
    })'
else
  echo "Replica set rs0 already initiated"
fi

echo "Waiting for rs1 to become primary"
wait_for "mongosh --quiet '$LOCAL' --eval 'if (!db.hello().isWritablePrimary) throw new Error(\"not primary\")'" "rs1 primary"

if mongosh --quiet "$AUTH" --eval 'db.runCommand({ping: 1})' >/dev/null 2>&1; then
  echo "Admin user already exists"
else
  echo "Creating admin user"
  mongosh --quiet "$LOCAL" --eval '
    db.getSiblingDB("admin").createUser(
      { user: "admin", pwd: "admin", roles: [{ role: "root", db: "admin" }] },
      { w: "majority" }
    )'
fi

echo "Replica set status:"
mongosh --quiet "$AUTH" --eval '
  rs.status().members.forEach(m => print(m.name + " " + m.stateStr))'

#!/usr/bin/env bash
# Writes the explain of every `// case:` statement in queries.js to
# packages/core/src/explain/fixtures/lab/<case>.executionStats.json. Run up.sh first.
set -euo pipefail
cd "$(dirname "$0")"
out=../../packages/core/src/explain/fixtures/lab
mkdir -p "$out"
# One mongosh script that prints each case's explain as a line of canonical EJSON.
node -e '
  const text = require("fs").readFileSync("queries.js", "utf8");
  console.log("db = db.getSiblingDB(\"explain_lab\");");
  for (const block of text.split(/^\/\/ case: /m).slice(1)) {
    const lines = block.split("\n");
    const name = lines[0].trim();
    const code = lines.slice(1).filter((l) => l.trim() !== "" && !l.trim().startsWith("//")).join("\n").trim().replace(/;$/, "");
    console.log(`print(EJSON.stringify({ case: ${JSON.stringify(name)}, explain: ${code}.explain("executionStats") }, { relaxed: false }));`);
  }
' > /tmp/explain-lab-capture.js
docker cp /tmp/explain-lab-capture.js mongo-gui-explain-lab:/tmp/capture.js
docker exec mongo-gui-explain-lab mongosh --quiet --file /tmp/capture.js |
  node -e '
    const fs = require("fs");
    for (const line of fs.readFileSync(0, "utf8").split("\n").filter((l) => l.startsWith("{"))) {
      const { case: name, explain } = JSON.parse(line);
      fs.writeFileSync(`${process.argv[1]}/${name}.executionStats.json`, JSON.stringify(explain, null, 2) + "\n");
      console.log(name);
    }
  ' "$out"

// Seeds perf.events with 1,000,000 documents. Safe to rerun: it inserts only the
// missing documents, so an interrupted run resumes where it stopped.
const TARGET = 1000000;
const BATCH = 10000;
const REPORT_EVERY = 100000;

const coll = db.getSiblingDB("perf").events;

const TYPES = ["view", "click", "purchase", "signup"];
const COUNTRIES = ["US", "DE", "GB", "FR", "SI", "NL", "SE", "IT", "ES", "JP"];
const DEVICES = ["ios", "android", "web"];
const TAGS = [
  "sale", "new", "promo", "beta", "vip", "mobile",
  "desktop", "returning", "trial", "partner", "email", "organic",
];
const NOW = Date.now();
const YEAR_MS = 365 * 24 * 3600 * 1000;

const rnd = (n) => Math.floor(Math.random() * n);

function makeDoc() {
  const tagCount = 1 + rnd(3);
  const tags = [];
  while (tags.length < tagCount) {
    const tag = TAGS[rnd(TAGS.length)];
    if (!tags.includes(tag)) tags.push(tag);
  }
  return {
    _id: new ObjectId(),
    userId: 1 + rnd(50000),
    type: TYPES[rnd(TYPES.length)],
    amount: new Double(rnd(50001) / 100),
    tags: tags,
    createdAt: new Date(NOW - rnd(YEAR_MS)),
    meta: { country: COUNTRIES[rnd(COUNTRIES.length)], device: DEVICES[rnd(DEVICES.length)] },
  };
}

const existing = coll.countDocuments({});
const toInsert = Math.max(0, TARGET - existing);
if (toInsert === 0) {
  print(`perf.events already has ${existing} documents. Nothing to insert.`);
} else {
  print(`perf.events has ${existing} documents. Inserting ${toInsert}.`);
  let inserted = 0;
  while (inserted < toInsert) {
    const n = Math.min(BATCH, toInsert - inserted);
    const docs = [];
    for (let i = 0; i < n; i++) docs.push(makeDoc());
    coll.insertMany(docs, { ordered: false, writeConcern: { w: 1 } });
    inserted += n;
    const total = existing + inserted;
    if (Math.floor(total / REPORT_EVERY) > Math.floor((total - n) / REPORT_EVERY)) {
      print(`Progress: ${total} of ${TARGET}`);
    }
  }
}

coll.createIndex({ userId: 1 });
coll.createIndex({ createdAt: -1 });
print(`Indexes: ${coll.getIndexes().map((i) => i.name).join(", ")}`);
print(`Final count: ${coll.countDocuments({})}`);

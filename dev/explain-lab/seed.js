// Seeds database `explain_lab` for the explain plan checks in queries.js. Rerun-safe: drops and
// rebuilds. The values come from a fixed seed, so every run gives the same data and the same plans.
const lab = db.getSiblingDB('explain_lab');
lab.dropDatabase();

// mulberry32: a small seeded generator whose low bits do not repeat in short cycles.
let state = 42;
const rnd = (n) => {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
};
const pick = (list) => list[rnd(list.length)];
const DAY_MS = 86_400_000;
const START = Date.UTC(2025, 0, 1);

function fill(name, count, make) {
  const coll = lab.getCollection(name);
  for (let i = 0; i < count; i += 1000) {
    const docs = [];
    for (let j = i; j < Math.min(count, i + 1000); j++) docs.push(make(j));
    coll.insertMany(docs, { ordered: false });
  }
  print(`${name}: ${count} docs`);
}

// A category tree four levels deep: 4 roots, each node with 3 children. $graphLookup walks it.
const categories = [];
let next = 1;
function addCategory(parentId, depth, name) {
  const id = next++;
  categories.push({ _id: id, name, parentId, depth });
  if (depth < 3) {
    for (let k = 0; k < 3; k++) addCategory(id, depth + 1, `${name}/${k}`);
  }
}
['books', 'games', 'garden', 'tools'].forEach((root) => addCategory(null, 0, root));
lab.categories.insertMany(categories);
print(`categories: ${categories.length} docs`);
const leaves = categories.filter((c) => c.depth === 3).map((c) => c._id);

const COUNTRIES = ['SI', 'AT', 'DE', 'IT', 'HR', 'FR', 'ES', 'NL'];
const TIERS = ['gold', 'silver', 'bronze'];
const STATUSES = ['new', 'paid', 'shipped', 'delivered', 'refunded', 'cancelled'];
const CHANNELS = ['web', 'app', 'phone', 'store'];
const CARRIERS = ['dhl', 'ups', 'gls', 'post'];
const WAREHOUSES = ['LJ', 'VIE', 'MUC', 'MIL'];

fill('customers', 5000, (i) => ({
  _id: i,
  email: `c${i}@example.com`,
  name: `Customer ${i}`,
  country: pick(COUNTRIES),
  tier: pick(TIERS),
  referredBy: i < 10 ? null : rnd(i),
  createdAt: new Date(START - rnd(700) * DAY_MS),
}));

fill('products', 2000, (i) => ({
  _id: i,
  sku: `SKU-${String(i).padStart(5, '0')}`,
  name: `Product ${i}`,
  categoryId: pick(leaves),
  price: 5 + rnd(495),
  tags: [pick(['new', 'sale', 'eco', 'gift']), pick(['small', 'large', 'bundle'])],
}));

fill('orders', 60000, (i) => {
  const items = [];
  const lines = 1 + rnd(4);
  for (let k = 0; k < lines; k++) {
    const productId = rnd(2000);
    items.push({ productId, qty: 1 + rnd(3), price: 5 + rnd(495) });
  }
  return {
    _id: i,
    customerId: rnd(5000),
    status: pick(STATUSES),
    channel: pick(CHANNELS),
    total: items.reduce((sum, item) => sum + item.qty * item.price, 0),
    createdAt: new Date(START + rnd(365) * DAY_MS + rnd(DAY_MS)),
    items,
  };
});

fill('reviews', 20000, (i) => ({
  _id: i,
  productId: rnd(2000),
  customerId: rnd(5000),
  rating: 1 + rnd(5),
  createdAt: new Date(START + rnd(365) * DAY_MS),
}));

fill('shipments', 40000, (i) => ({
  _id: i,
  orderId: rnd(60000),
  warehouse: pick(WAREHOUSES),
  carrier: pick(CARRIERS),
  shippedAt: new Date(START + rnd(365) * DAY_MS),
}));

// reviews.customerId and shipments.carrier have no index on purpose, so some joins scan.
lab.customers.createIndex({ email: 1 }, { unique: true });
lab.customers.createIndex({ country: 1, tier: 1 });
lab.products.createIndex({ sku: 1 }, { unique: true });
lab.products.createIndex({ categoryId: 1 });
lab.categories.createIndex({ parentId: 1 });
lab.orders.createIndex({ status: 1, createdAt: -1 });
lab.orders.createIndex({ channel: 1, createdAt: -1 });
lab.orders.createIndex({ customerId: 1, createdAt: -1 });
lab.orders.createIndex({ 'items.productId': 1 });
lab.reviews.createIndex({ productId: 1, rating: -1 });
lab.shipments.createIndex({ orderId: 1 });
print('indexes created');

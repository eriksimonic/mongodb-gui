// Seeds database `grid` with collections that stress the results grid. Rerun-safe: drops and rebuilds.
const g = db.getSiblingDB('grid');
const rnd = (n) => Math.floor(Math.random() * n);
const word = () => Math.random().toString(36).slice(2, 10);
const text = (n) => {
  let s = '';
  while (s.length < n) s += word() + ' ';
  return s.slice(0, n);
};

function fill(name, count, make, batch = 1000) {
  const c = g.getCollection(name);
  c.drop();
  for (let i = 0; i < count; i += batch) {
    const docs = [];
    for (let j = i; j < Math.min(count, i + batch); j++) docs.push(make(j));
    c.insertMany(docs, { ordered: false });
  }
  print(`${name}: ${count} docs`);
}

// 1M flat small docs: the baseline.
fill(
  'flat_1m',
  1000000,
  (i) => ({
    n: i,
    user: 'u' + rnd(50000),
    amount: Math.random() * 500,
    at: new Date(Date.now() - rnd(3e10)),
    tags: ['a', 'b'].slice(0, 1 + rnd(2)),
  }),
  10000,
);

// Deep nesting: 15 levels, each level has siblings, so flattening yields many dotted columns.
function nest(depth) {
  const o = { v: rnd(1000), s: word() };
  if (depth > 0) o.child = nest(depth - 1);
  return o;
}
fill('nested_deep', 100000, (i) => ({ n: i, root: nest(15) }));

// Wide: 400 top-level fields per doc, same schema.
fill(
  'wide_400',
  20000,
  (i) => {
    const d = { n: i };
    for (let f = 0; f < 400; f++) d['f' + f] = f % 3 ? rnd(1e6) : word();
    return d;
  },
  500,
);

// Heterogeneous: every doc has ~20 random keys from a pool of 5000, so column discovery explodes.
fill(
  'sparse_keys',
  20000,
  (i) => {
    const d = { n: i };
    for (let f = 0; f < 20; f++) d['k' + rnd(5000)] = rnd(1000);
    return d;
  },
  500,
);

// Big documents: ~256 KB each, large strings plus long arrays of subdocs.
fill(
  'big_docs',
  2000,
  (i) => ({
    n: i,
    title: word(),
    body: text(100000),
    items: Array.from({ length: 500 }, (_, k) => ({
      k,
      label: word(),
      price: Math.random(),
      dims: { w: rnd(99), h: rnd(99) },
    })),
    log: Array.from({ length: 1000 }, () => ({ at: new Date(), msg: text(40) })),
  }),
  50,
);

// Huge arrays: 5 MB of numbers in one field, a few docs near the 16 MB limit's low end.
fill(
  'huge_arrays',
  100,
  (i) => ({
    n: i,
    series: Array.from({ length: 200000 }, () => Math.random()),
  }),
  5,
);

// Mixed: nested and arrays of nested with varying BSON types in the same field.
fill('mixed_types', 100000, (i) => ({
  n: i,
  val: [i, String(i), null, new Date(), { x: i }, [i], NumberLong(i), NumberDecimal('1.5')][i % 8],
  orders: Array.from({ length: rnd(20) }, () => ({
    sku: word(),
    qty: rnd(9),
    meta: { tags: [word(), word()] },
  })),
}));

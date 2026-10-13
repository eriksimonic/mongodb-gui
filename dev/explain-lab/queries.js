// Statements for the Explain tab, on database `explain_lab`. Paste the file into an editor tab,
// put the cursor on a statement and run Explain. Each `// case:` line names the committed fixture
// the statement was captured into, under packages/core/src/explain/fixtures/lab. The mock UI
// matches these statements by their text, so keep a statement and its fixture in step.

// case: sort-merge-or
// Two index scans merged in createdAt order by SORT_MERGE, then a limit.
db.orders
  .find({ $or: [{ status: 'refunded' }, { channel: 'phone' }] })
  .sort({ createdAt: -1 })
  .limit(50);

// case: sort-merge-in
// The $in on the index prefix becomes one index scan per value, merged by SORT_MERGE.
db.orders
  .find({ status: { $in: ['paid', 'shipped', 'refunded', 'cancelled'] } })
  .sort({ createdAt: -1 })
  .limit(20);

// case: sort-merge-wide
// Three $or branches on three indexes, two of them with an $in, so SORT_MERGE has many inputs.
db.orders
  .find({
    $or: [
      { status: 'refunded', total: { $gt: 1500 } },
      { channel: { $in: ['phone', 'store'] } },
      { customerId: { $in: [7, 42, 99, 512] } },
    ],
  })
  .sort({ createdAt: -1 })
  .limit(100);

// case: orders-deep-lookup
// Paid orders joined to customers, products with their category chain and reviews, and
// shipments, then grouped by country.
db.orders.aggregate([
  {
    $match: {
      status: 'paid',
      createdAt: { $gte: ISODate('2025-06-01'), $lt: ISODate('2025-07-01') },
    },
  },
  { $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'customer' } },
  { $unwind: '$customer' },
  { $unwind: '$items' },
  {
    $lookup: {
      from: 'products',
      localField: 'items.productId',
      foreignField: '_id',
      as: 'product',
      pipeline: [
        {
          $lookup: {
            from: 'categories',
            localField: 'categoryId',
            foreignField: '_id',
            as: 'category',
          },
        },
        {
          $lookup: {
            from: 'reviews',
            localField: '_id',
            foreignField: 'productId',
            as: 'reviews',
            pipeline: [{ $group: { _id: null, avg: { $avg: '$rating' }, n: { $sum: 1 } } }],
          },
        },
      ],
    },
  },
  { $unwind: '$product' },
  { $lookup: { from: 'shipments', localField: '_id', foreignField: 'orderId', as: 'shipments' } },
  {
    $group: {
      _id: '$customer.country',
      revenue: { $sum: { $multiply: ['$items.qty', '$items.price'] } },
      orders: { $addToSet: '$_id' },
      shipped: { $sum: { $size: '$shipments' } },
    },
  },
  { $sort: { revenue: -1 } },
  { $limit: 5 },
]);

// case: facet-dashboard
// One pass over the year's orders, split into four $facet branches. One branch joins customers.
db.orders.aggregate([
  { $match: { createdAt: { $gte: ISODate('2025-01-01'), $lt: ISODate('2026-01-01') } } },
  {
    $facet: {
      byStatus: [
        { $group: { _id: '$status', n: { $sum: 1 }, revenue: { $sum: '$total' } } },
        { $sort: { n: -1 } },
      ],
      byChannel: [{ $sortByCount: '$channel' }],
      topCustomers: [
        { $group: { _id: '$customerId', spent: { $sum: '$total' } } },
        { $sort: { spent: -1 } },
        { $limit: 10 },
        { $lookup: { from: 'customers', localField: '_id', foreignField: '_id', as: 'customer' } },
      ],
      byMonth: [
        { $group: { _id: { $month: '$createdAt' }, n: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ],
    },
  },
]);

// case: union-ratings
// Refunded orders and low reviews in one stream, each side with its own join, then grouped.
db.orders.aggregate([
  { $match: { status: 'refunded', channel: 'web' } },
  { $project: { customerId: 1, kind: { $literal: 'refund' } } },
  {
    $unionWith: {
      coll: 'reviews',
      pipeline: [
        { $match: { rating: 1 } },
        {
          $lookup: {
            from: 'products',
            localField: 'productId',
            foreignField: '_id',
            as: 'product',
          },
        },
        { $project: { customerId: 1, kind: { $literal: 'review' } } },
      ],
    },
  },
  { $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'customer' } },
  { $group: { _id: { kind: '$kind', tier: { $first: '$customer.tier' } }, n: { $sum: 1 } } },
  { $sort: { n: -1 } },
]);

// case: category-graph
// Products in one subtree with their category ancestors from $graphLookup and their reviews
// joined on a field without an index.
db.products.aggregate([
  { $match: { categoryId: { $in: [4, 5, 6] } } },
  {
    $graphLookup: {
      from: 'categories',
      startWith: '$categoryId',
      connectFromField: 'parentId',
      connectToField: '_id',
      as: 'path',
      maxDepth: 4,
    },
  },
  {
    $lookup: {
      from: 'reviews',
      let: { p: '$_id' },
      pipeline: [
        { $match: { $expr: { $eq: ['$productId', '$$p'] } } },
        {
          $lookup: {
            from: 'customers',
            localField: 'customerId',
            foreignField: '_id',
            as: 'author',
          },
        },
        { $sort: { rating: -1 } },
        { $limit: 3 },
      ],
      as: 'topReviews',
    },
  },
  { $project: { name: 1, depth: { $size: '$path' }, topReviews: 1 } },
  { $sort: { depth: -1, name: 1 } },
]);

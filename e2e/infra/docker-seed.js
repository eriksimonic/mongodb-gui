/* global db */
// Runs once, from the image entrypoint, on the first start of an empty data dir.
db.getSiblingDB('docker_shop').orders.insertMany([
  { orderNumber: 1, status: 'paid' },
  { orderNumber: 2, status: 'open' },
]);

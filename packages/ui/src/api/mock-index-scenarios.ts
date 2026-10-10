import type { IndexInfo } from '@mongo-gui/core';

/**
 * One index per kind the IndexInfo schema can express, for the scenario tests. The schema has no
 * building flag, so a build in progress comes from listIndexBuilds and is not listed here.
 */
export const indexScenarios: readonly IndexInfo[] = [
  { name: '_id_', key: { _id: 1 }, size: 20_480 },
  { name: 'status_1', key: { status: 1 }, size: 16_384 },
  {
    name: 'createdAt_-1',
    key: { createdAt: -1 },
    size: 16_384,
    usage: { ops: 0, since: '2026-10-01T00:00:00.000Z' },
  },
  {
    name: 'status_1_createdAt_-1_customerId_1',
    key: { status: 1, createdAt: -1, customerId: 1 },
    size: 36_864,
    usage: { ops: 412, since: '2026-10-01T00:00:00.000Z' },
  },
  { name: 'email_1', key: { email: 1 }, unique: true, size: 16_384 },
  { name: 'nickname_1', key: { nickname: 1 }, sparse: true, size: 16_384 },
  {
    name: 'total_1',
    key: { total: 1 },
    partialFilterExpressionEjson: '{"status":"paid"}',
    size: 16_384,
  },
  { name: 'lastSeen_1', key: { lastSeen: 1 }, expireAfterSeconds: 3600, size: 16_384 },
  { name: 'expiresAt_1', key: { expiresAt: 1 }, expireAfterSeconds: 0, size: 16_384 },
  {
    name: 'title_text_body_text',
    key: { title: 'text', body: 'text' },
    weights: { title: 10, body: 1 },
    defaultLanguage: 'english',
    size: 49_152,
  },
  {
    name: 'notes_text_server_shape',
    key: { _fts: 'text', _ftsx: 1 },
    weights: { notes: 1 },
    size: 49_152,
  },
  { name: 'location_2dsphere', key: { location: '2dsphere' }, size: 16_384 },
  { name: 'legacyPoint_2d', key: { legacyPoint: '2d' }, size: 16_384 },
  { name: 'customerId_hashed', key: { customerId: 'hashed' }, size: 16_384 },
  { name: '$**_1', key: { '$**': 1 }, size: 65_536 },
  {
    name: 'all_wildcard_projected',
    key: { '$**': 1 },
    wildcardProjectionEjson: '{"name":1,"attributes":1}',
    size: 65_536,
  },
  { name: 'attributes.$**_1', key: { 'attributes.$**': 1 }, size: 32_768 },
  {
    name: 'attributes_wildcard_projected',
    key: { 'attributes.$**': 1 },
    wildcardProjectionEjson: '{"attributes.color":1}',
    size: 32_768,
  },
  {
    name: 'name_1',
    key: { name: 1 },
    collationEjson: '{"locale":"en","strength":2}',
    size: 16_384,
  },
  { name: 'legacyRef_1', key: { legacyRef: 1 }, hidden: true, size: 16_384 },
  {
    name: 'orders_status_1_customerId_1_createdAt_-1_shippingRegion_1_totalCents_-1_currency_1_channel_1_warehouseCode_1',
    key: {
      status: 1,
      customerId: 1,
      createdAt: -1,
      shippingRegion: 1,
      totalCents: -1,
      currency: 1,
      channel: 1,
      warehouseCode: 1,
    },
    size: 131_072,
  },
  {
    name: 'shipping.address.postalCode_1',
    key: { 'shipping.address.postalCode': 1 },
    size: 16_384,
  },
  { name: 'taxId_1', key: { taxId: 1 }, unique: true, sparse: true, size: 16_384 },
  { name: 'region_1', key: { region: 1 } },
  {
    name: 'sessionId_1_combo',
    key: { sessionId: 1 },
    unique: true,
    expireAfterSeconds: 900,
    partialFilterExpressionEjson: '{"active":true}',
    size: 16_384,
  },
  {
    name: 'tenant_1',
    key: { tenant: 1 },
    extraOptionsEjson: '{"storageEngine":{"wiredTiger":{"configString":"block_compressor=zstd"}}}',
    size: 16_384,
  },
];

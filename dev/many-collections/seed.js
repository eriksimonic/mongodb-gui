// Seeds 100 databases of one application profile. Run with --eval "var APP = 'shop'".
// Database names read like real tenants (amber_falcon_shop). Each database holds 100 collections:
// 12 shared infrastructure collections, 28 application entities, history, archive, import and report collections.
const ENTITIES = {
  shop: ['customers', 'products', 'product_variants', 'categories', 'brands', 'carts', 'cart_items', 'orders', 'order_items', 'payments', 'refunds', 'invoices', 'shipments', 'shipping_rates', 'returns', 'reviews', 'wishlists', 'coupons', 'promotions', 'inventory', 'warehouses', 'suppliers', 'purchase_orders', 'addresses', 'tax_rates', 'gift_cards', 'loyalty_points', 'price_lists'],
  crm: ['contacts', 'accounts', 'leads', 'opportunities', 'pipelines', 'stages', 'activities', 'notes', 'tasks', 'meetings', 'calls', 'emails', 'campaigns', 'campaign_members', 'segments', 'quotes', 'quote_lines', 'contracts', 'products', 'price_books', 'territories', 'teams', 'users', 'roles', 'tags', 'attachments', 'custom_fields', 'dedupe_candidates'],
  cms: ['articles', 'article_versions', 'authors', 'categories', 'tags', 'comments', 'media_assets', 'media_folders', 'pages', 'page_blocks', 'menus', 'menu_items', 'redirects', 'subscribers', 'newsletters', 'newsletter_sends', 'forms', 'form_submissions', 'widgets', 'themes', 'translations', 'locales', 'search_queries', 'reactions', 'bookmarks', 'users', 'roles', 'seo_metadata'],
  iot: ['devices', 'device_groups', 'device_models', 'firmware_versions', 'firmware_rollouts', 'gateways', 'sites', 'zones', 'sensors', 'readings', 'readings_hourly', 'readings_daily', 'alerts', 'alert_rules', 'commands', 'command_results', 'heartbeats', 'calibrations', 'maintenance_windows', 'work_orders', 'technicians', 'tenants', 'users', 'api_clients', 'geofences', 'battery_reports', 'connectivity_events', 'certificates'],
  logistics: ['shipments', 'parcels', 'parcel_scans', 'tracking_events', 'routes', 'route_stops', 'vehicles', 'vehicle_inspections', 'drivers', 'driver_shifts', 'depots', 'dock_slots', 'manifests', 'customs_declarations', 'carriers', 'carrier_rates', 'pickups', 'deliveries', 'proof_of_delivery', 'damage_claims', 'invoices', 'contracts', 'service_zones', 'schedules', 'fuel_logs', 'toll_charges', 'customers', 'addresses'],
};
const INFRA = ['audit_log', 'schema_migrations', 'job_queue', 'job_failures', 'feature_flags', 'api_keys', 'webhook_outbox', 'webhook_deliveries', 'rate_limits', 'sessions', 'notifications', 'settings'];
const REPORTS = ['report_daily', 'report_weekly', 'report_monthly', 'report_quarterly', 'report_yearly', 'report_adhoc', 'report_cache', 'report_exports'];
const ADJECTIVES = ['amber', 'blue', 'brisk', 'calm', 'cedar', 'coral', 'dusty', 'eager', 'fern', 'golden', 'harbor', 'iron', 'jade', 'keen', 'lunar', 'maple', 'noble', 'olive', 'pearl', 'quiet', 'river', 'silver', 'swift', 'terra', 'urban'];
const NOUNS = ['falcon', 'otter', 'lantern', 'anchor', 'meadow', 'summit', 'orchard', 'beacon', 'canyon', 'delta', 'ember', 'forge', 'grove', 'haven', 'island', 'junction', 'kettle', 'ledger', 'mill', 'nest'];
const APPS = ['shop', 'crm', 'cms', 'iot', 'logistics'];

const entities = ENTITIES[APP];
if (!entities) throw new Error('Unknown APP ' + APP);
const appIndex = APPS.indexOf(APP);
const names = [...INFRA, ...entities];
entities.slice(0, 20).forEach((e) => names.push(e + '_history'));
entities.slice(0, 10).forEach((e) => names.push(e + '_archive_2023'));
entities.slice(0, 10).forEach((e) => names.push(e + '_archive_2024'));
for (let m = 1; m <= 12; m++) names.push('tmp_import_2025_' + String(m).padStart(2, '0'));
REPORTS.forEach((r) => names.push(r));
if (names.length !== 100) throw new Error('Expected 100 collections, got ' + names.length);

for (let t = 0; t < 100; t++) {
  // 25 adjectives x 20 nouns = 500 unique company names, 100 per application.
  const k = appIndex * 100 + t;
  const slug = ADJECTIVES[k % 25] + '_' + NOUNS[Math.floor(k / 25)];
  const d = db.getSiblingDB(slug + '_' + APP);
  if (d.getCollectionNames().length >= 100) continue;
  names.forEach((name, n) => {
    const core = n >= INFRA.length && n < INFRA.length + entities.length;
    const docs = core ? 20 + ((t * 13 + n * 7) % 180) : (t * 7 + n * 3) % 15;
    d.createCollection(name);
    if (docs > 0) {
      const batch = [];
      for (let i = 0; i < docs; i++) {
        batch.push({ seq: i, tenant: slug, status: ['new', 'active', 'done', 'failed'][(i + n) % 4], amount: (i * 37 + n) % 900, createdAt: new Date(1.72e12 + i * 3600000 * (n + 1)) });
      }
      d[name].insertMany(batch);
    }
  });
  if ((t + 1) % 10 === 0) print(APP + ': ' + (t + 1) + '/100 databases');
}

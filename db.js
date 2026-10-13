'use strict';
// SQLite database (built into Node 22.13+, no install needed).
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'store.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  brand       TEXT    NOT NULL DEFAULT '',
  category    TEXT    NOT NULL,
  spec        TEXT    NOT NULL DEFAULT '',
  price       INTEGER NOT NULL CHECK (price >= 0),
  old_price   INTEGER,
  stock       INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  warranty    TEXT    NOT NULL DEFAULT '',
  icon        TEXT    NOT NULL DEFAULT 'phone',
  image       TEXT    NOT NULL DEFAULT '',
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT    NOT NULL UNIQUE,
  customer_name TEXT    NOT NULL,
  phone         TEXT    NOT NULL,
  city          TEXT    NOT NULL,
  address       TEXT    NOT NULL,
  payment       TEXT    NOT NULL,
  subtotal      INTEGER NOT NULL,
  delivery      INTEGER NOT NULL,
  total         INTEGER NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'new',
  note          TEXT    NOT NULL DEFAULT '',
  created_at    TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS order_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id  INTEGER,
  name        TEXT    NOT NULL,
  price       INTEGER NOT NULL,
  qty         INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_status  ON orders(status, created_at);
CREATE INDEX IF NOT EXISTS idx_items_order    ON order_items(order_id);
`);

// ---- settings -------------------------------------------------------------
const SETTING_DEFAULTS = {
  shop_name: 'Mobile Corner',
  tagline: 'Mobiles, accessories and gadgets',
  whatsapp: '',               // 923001234567 (country code, digits only)
  jazzcash: '',
  easypaisa: '',
  account_name: '',
  delivery_fee: '250',
  free_delivery_over: '15000',
  announcement: ''
};
const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(SETTING_DEFAULTS)) insertSetting.run(k, v);

function getSettings() {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}
function setSettings(obj) {
  const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const k of Object.keys(SETTING_DEFAULTS)) {
    if (obj[k] !== undefined) up.run(k, String(obj[k]));
  }
}

// ---- sample products (first run only; set SEED_SAMPLES=0 to skip) ----------
if (process.env.SEED_SAMPLES !== '0' && db.prepare('SELECT COUNT(*) AS n FROM products').get().n === 0) {
  const ins = db.prepare(`INSERT INTO products (name, brand, category, spec, price, old_price, stock, warranty, icon)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const rows = [
    ['Redmi 13C', 'Xiaomi', 'Mobiles', '6GB RAM, 128GB, 6.74" display, 5000mAh', 36500, 39000, 8, '1 year', 'phone'],
    ['Galaxy A15', 'Samsung', 'Mobiles', '8GB RAM, 128GB, AMOLED, 5000mAh', 52500, null, 5, '1 year', 'phone'],
    ['Hot 40i', 'Infinix', 'Mobiles', '8GB RAM, 128GB, 90Hz, 5000mAh', 31000, null, 12, '1 year', 'phone'],
    ['Spark 20', 'Tecno', 'Mobiles', '8GB RAM, 256GB, 6.6" display', 38900, null, 2, '1 year', 'phone'],
    ['33W Fast Charger', 'Anker', 'Chargers & Cables', 'USB-C, GaN, cable not included', 3200, null, 25, '6 months', 'charger'],
    ['Type-C Cable 1m', 'Generic', 'Chargers & Cables', '60W, braided', 550, null, 60, '7 days', 'cable'],
    ['Power Bank 20000mAh', 'Baseus', 'Chargers & Cables', '22.5W, dual output, LED display', 7800, 8500, 9, '6 months', 'bank'],
    ['T13 Earbuds', 'QCY', 'Audio', 'Bluetooth 5.3, 30h with case', 4300, null, 14, '6 months', 'buds'],
    ['Go 3 Speaker', 'JBL', 'Audio', 'Bluetooth, IP67, 5h playtime', 9500, null, 6, '1 year', 'speaker'],
    ['Smart Band 8', 'Xiaomi', 'Wearables', '1.62" AMOLED, 16 day battery', 8900, null, 7, '6 months', 'watch'],
    ['Tempered Glass 9H', 'Generic', 'Cases & Protection', 'Tell us your phone model on WhatsApp', 350, null, 100, '', 'glass'],
    ['Silicone Case', 'Spigen', 'Cases & Protection', 'Soft-touch, most popular models', 1200, null, 30, '', 'case']
  ];
  db.exec('BEGIN');
  try { for (const r of rows) ins.run(...r); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { db, DATA_DIR, getSettings, setSettings, SETTING_DEFAULTS };

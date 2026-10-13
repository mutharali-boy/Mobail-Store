'use strict';
// Mobile Store server: no external packages, needs Node.js 22.13 or newer.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---- .env loader (simple KEY=VALUE lines) -----------------------------------
try {
  const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (_) { /* no .env file, use real environment variables */ }

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
if (ADMIN_PASSWORD.length < 8) {
  console.error('\nSet ADMIN_PASSWORD (at least 8 characters) in your .env file or environment variables, then start again.\n');
  process.exit(1);
}
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('sess:' + ADMIN_PASSWORD).digest('hex');

const { db, DATA_DIR, getSettings, setSettings } = require('./db');
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

// ---- helpers ----------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};
const ICONS = ['phone', 'charger', 'cable', 'bank', 'buds', 'speaker', 'watch', 'glass', 'case'];
const STATUSES = ['new', 'confirmed', 'shipped', 'delivered', 'cancelled'];
const PAYMENTS = ['Cash on delivery', 'JazzCash', 'Easypaisa'];

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  const payload = isObj ? JSON.stringify(body) : body;
  res.writeHead(status, { 'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(payload);
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

const hits = new Map(); // rate limiter: key -> [timestamps]
function rateLimit(req, bucket, max, windowMs) {
  const key = bucket + ':' + clientIp(req);
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) throw new HttpError(429, 'Too many requests. Please wait a few minutes and try again.');
  arr.push(now);
  hits.set(key, arr);
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();

function readJson(req, limit = 50 * 1024) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) return reject(new HttpError(415, 'Send JSON.'));
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpError(413, 'Request too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new HttpError(400, 'Invalid JSON.')); } });
    req.on('error', reject);
  });
}

// ---- admin session (signed cookie) ------------------------------------------
const SESSION_MS = 12 * 3600e3;
function sign(data) { return crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url'); }
function makeToken() { const p = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_MS })).toString('base64url'); return p + '.' + sign(p); }
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  return out;
}
function isAdmin(req) {
  const tok = parseCookies(req).sid; if (!tok) return false;
  const [p, s] = tok.split('.'); if (!p || !s) return false;
  const good = Buffer.from(sign(p)), got = Buffer.from(s);
  if (good.length !== got.length || !crypto.timingSafeEqual(good, got)) return false;
  try { return JSON.parse(Buffer.from(p, 'base64url').toString()).exp > Date.now(); } catch { return false; }
}
function requireAdmin(req) { if (!isAdmin(req)) throw new HttpError(401, 'Please sign in.'); }
function cookieHeader(req, value, maxAge) {
  const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  return `sid=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest(), hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---- validation -------------------------------------------------------------
const str = (v, min, max, label) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length < min || s.length > max) throw new HttpError(400, `${label} must be ${min}-${max} characters.`);
  return s;
};
const optStr = (v, max, label) => { const s = typeof v === 'string' ? v.trim() : ''; if (s.length > max) throw new HttpError(400, `${label} is too long.`); return s; };
const int = (v, min, max, label) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${label} must be a whole number from ${min} to ${max}.`);
  return n;
};
function normalizePhone(v) {
  const d = String(v || '').replace(/[\s\-()]/g, '');
  const m = d.match(/^(?:\+?92|0)?(3\d{9})$/);
  if (!m) throw new HttpError(400, 'Enter a Pakistani mobile number, for example 0300 1234567.');
  return '0' + m[1];
}

// ---- products -----------------------------------------------------------
const publicProduct = p => ({ id: p.id, name: p.name, brand: p.brand, category: p.category, spec: p.spec, price: p.price, old_price: p.old_price, stock: p.stock, warranty: p.warranty, icon: p.icon, image: p.image });

function saveImage(dataUrl) {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) throw new HttpError(400, 'Image must be a PNG, JPG or WebP file.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 3 * 1024 * 1024) throw new HttpError(400, 'Image must be smaller than 3 MB.');
  const ok = m[1] === 'png' ? buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    : m[1] === 'jpeg' ? buf[0] === 0xff && buf[1] === 0xd8
    : buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP';
  if (!ok) throw new HttpError(400, 'That file is not a valid image.');
  const name = crypto.randomBytes(12).toString('hex') + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return '/uploads/' + name;
}
function removeImage(url) {
  if (!url || !url.startsWith('/uploads/')) return;
  const f = path.join(UPLOAD_DIR, path.basename(url));
  fs.rm(f, { force: true }, () => {});
}
function parseProduct(b, existing) {
  const price = int(b.price, 0, 100000000, 'Price');
  let old = b.old_price === '' || b.old_price == null ? null : int(b.old_price, 0, 100000000, 'Old price');
  if (old !== null && old <= price) old = null;
  let image = existing ? existing.image : '';
  const out = {
    name: str(b.name, 2, 120, 'Name'), brand: optStr(b.brand, 60, 'Brand'), category: str(b.category, 2, 60, 'Category'),
    spec: optStr(b.spec, 240, 'Details'), price, old_price: old, stock: int(b.stock, 0, 100000, 'Stock'),
    warranty: optStr(b.warranty, 60, 'Warranty'), icon: ICONS.includes(b.icon) ? b.icon : 'phone', active: b.active === false || b.active === 0 ? 0 : 1
  };
  if (b.image_data) { const fresh = saveImage(b.image_data); if (existing) removeImage(existing.image); image = fresh; }
  else if (b.remove_image && existing) { removeImage(existing.image); image = ''; }
  out.image = image;
  return out;
}

// ---- orders -------------------------------------------------------------
function newCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = ''; for (const b of crypto.randomBytes(6)) s += alphabet[b % alphabet.length];
  return 'ORD-' + s;
}
function createOrder(b) {
  const name = str(b.name, 2, 80, 'Name'), phone = normalizePhone(b.phone), city = str(b.city, 2, 60, 'City');
  const address = str(b.address, 6, 300, 'Address'), note = optStr(b.note, 300, 'Note');
  if (!PAYMENTS.includes(b.payment)) throw new HttpError(400, 'Choose a payment method.');
  if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 30) throw new HttpError(400, 'Your cart is empty.');
  const wanted = new Map();
  for (const it of b.items) { const id = int(it && it.id, 1, 1e9, 'Product'), q = int(it && it.qty, 1, 20, 'Quantity'); wanted.set(id, (wanted.get(id) || 0) + q); }
  const cfg = getSettings();
  db.exec('BEGIN IMMEDIATE');
  try {
    const getP = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1');
    const dec = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?');
    let subtotal = 0; const lines = [];
    for (const [id, qty] of wanted) {
      const p = getP.get(id);
      if (!p) throw new HttpError(409, 'An item in your cart is no longer available. Please refresh the page.');
      if (p.stock < qty) throw new HttpError(409, p.stock > 0 ? `Only ${p.stock} of "${p.name}" left in stock.` : `"${p.name}" is out of stock.`);
      if (dec.run(qty, id, qty).changes !== 1) throw new HttpError(409, `"${p.name}" just sold out.`);
      subtotal += p.price * qty; lines.push({ id, name: p.name, price: p.price, qty });
    }
    const fee = Number(cfg.delivery_fee) || 0, free = Number(cfg.free_delivery_over) || 0;
    const delivery = subtotal >= free && free > 0 ? 0 : fee, total = subtotal + delivery;
    let code, tries = 0;
    do { code = newCode(); } while (db.prepare('SELECT 1 FROM orders WHERE code = ?').get(code) && ++tries < 10);
    const r = db.prepare('INSERT INTO orders (code, customer_name, phone, city, address, payment, subtotal, delivery, total, note) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(code, name, phone, city, address, b.payment, subtotal, delivery, total, note);
    const insI = db.prepare('INSERT INTO order_items (order_id, product_id, name, price, qty) VALUES (?,?,?,?,?)');
    for (const l of lines) insI.run(r.lastInsertRowid, l.id, l.name, l.price, l.qty);
    db.exec('COMMIT');
    return { code, subtotal, delivery, total, payment: b.payment, items: lines };
  } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
}
function orderWithItems(o) { return { ...o, items: db.prepare('SELECT product_id, name, price, qty FROM order_items WHERE order_id = ?').all(o.id) }; }

function setOrderStatus(id, status) {
  if (!STATUSES.includes(status)) throw new HttpError(400, 'Unknown status.');
  db.exec('BEGIN IMMEDIATE');
  try {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!o) throw new HttpError(404, 'Order not found.');
    if (o.status === 'cancelled' && status !== 'cancelled') throw new HttpError(400, 'A cancelled order cannot be reopened. Ask the customer to place a new order.');
    if (status === 'cancelled' && o.status !== 'cancelled') {
      const back = db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?');
      for (const it of db.prepare('SELECT product_id, qty FROM order_items WHERE order_id = ?').all(id)) if (it.product_id) back.run(it.qty, it.product_id);
    }
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, id);
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
}

// ---- API routes -------------------------------------------------------------
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp('^' + pattern + '$'), handler });

route('GET', '/healthz', async () => ({ status: 200, body: { ok: true } }));

route('GET', '/api/config', async () => {
  const s = getSettings();
  return { body: { shopName: s.shop_name, tagline: s.tagline, whatsapp: s.whatsapp, jazzcash: s.jazzcash, easypaisa: s.easypaisa, accountName: s.account_name, deliveryFee: Number(s.delivery_fee) || 0, freeDeliveryOver: Number(s.free_delivery_over) || 0, announcement: s.announcement } };
});
route('GET', '/api/products', async () => ({ body: db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY category, id').all().map(publicProduct) }));

route('POST', '/api/orders', async (req) => {
  rateLimit(req, 'order', 15, 3600e3);
  return { status: 201, body: createOrder(await readJson(req)) };
});
route('GET', '/api/track', async (req, url) => {
  rateLimit(req, 'track', 30, 3600e3);
  const code = String(url.searchParams.get('code') || '').trim().toUpperCase(), phone = String(url.searchParams.get('phone') || '').replace(/\D/g, '');
  const o = db.prepare('SELECT code, status, total, payment, phone, created_at FROM orders WHERE code = ?').get(code);
  if (!o || phone.length < 4 || !o.phone.endsWith(phone.slice(-4))) throw new HttpError(404, 'No order found. Check the order code and the phone number you used.');
  return { body: { code: o.code, status: o.status, total: o.total, payment: o.payment, created_at: o.created_at } };
});

route('POST', '/api/admin/login', async (req, res) => {
  rateLimit(req, 'login', 8, 15 * 60e3);
  const b = await readJson(req);
  if (!safeEqual(b.password || '', ADMIN_PASSWORD)) throw new HttpError(401, 'Wrong password.');
  return { body: { ok: true }, headers: { 'Set-Cookie': cookieHeader(req, makeToken(), SESSION_MS / 1000) } };
});
route('POST', '/api/admin/logout', async (req) => ({ body: { ok: true }, headers: { 'Set-Cookie': cookieHeader(req, '', 0) } }));
route('GET', '/api/admin/me', async (req) => ({ body: { admin: isAdmin(req) } }));

route('GET', '/api/admin/stats', async (req) => {
  requireAdmin(req);
  const by = {}; for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status').all()) by[r.status] = r.n;
  const rev = db.prepare("SELECT COALESCE(SUM(total),0) AS t FROM orders WHERE status = 'delivered'").get().t;
  const today = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE date(created_at) = date('now')").get().n;
  const low = db.prepare('SELECT COUNT(*) AS n FROM products WHERE active = 1 AND stock <= 3').get().n;
  return { body: { byStatus: by, deliveredRevenue: rev, ordersToday: today, lowStock: low } };
});

route('GET', '/api/admin/orders', async (req, url) => {
  requireAdmin(req);
  const st = url.searchParams.get('status') || '', q = (url.searchParams.get('q') || '').trim();
  let sql = 'SELECT * FROM orders WHERE 1=1'; const args = [];
  if (STATUSES.includes(st)) { sql += ' AND status = ?'; args.push(st); }
  if (q) { sql += ' AND (code LIKE ? OR customer_name LIKE ? OR phone LIKE ?)'; const like = `%${q.replace(/[%_]/g, '')}%`; args.push(like, like, like); }
  sql += ' ORDER BY id DESC LIMIT 200';
  return { body: db.prepare(sql).all(...args).map(orderWithItems) };
});
route('PATCH', '/api/admin/orders/(\\d+)', async (req, url, m) => {
  requireAdmin(req); setOrderStatus(Number(m[1]), (await readJson(req)).status); return { body: { ok: true } };
});

route('GET', '/api/admin/products', async (req) => { requireAdmin(req); return { body: db.prepare('SELECT * FROM products ORDER BY category, id').all() }; });
route('POST', '/api/admin/products', async (req) => {
  requireAdmin(req);
  const p = parseProduct(await readJson(req, 5 * 1024 * 1024), null);
  const r = db.prepare('INSERT INTO products (name, brand, category, spec, price, old_price, stock, warranty, icon, image, active) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(p.name, p.brand, p.category, p.spec, p.price, p.old_price, p.stock, p.warranty, p.icon, p.image, p.active);
  return { status: 201, body: { id: Number(r.lastInsertRowid) } };
});
route('PUT', '/api/admin/products/(\\d+)', async (req, url, m) => {
  requireAdmin(req);
  const ex = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(m[1]));
  if (!ex) throw new HttpError(404, 'Product not found.');
  const p = parseProduct(await readJson(req, 5 * 1024 * 1024), ex);
  db.prepare('UPDATE products SET name=?, brand=?, category=?, spec=?, price=?, old_price=?, stock=?, warranty=?, icon=?, image=?, active=? WHERE id=?')
    .run(p.name, p.brand, p.category, p.spec, p.price, p.old_price, p.stock, p.warranty, p.icon, p.image, p.active, ex.id);
  return { body: { ok: true } };
});
route('DELETE', '/api/admin/products/(\\d+)', async (req, url, m) => {
  requireAdmin(req);
  const ex = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(m[1]));
  if (!ex) throw new HttpError(404, 'Product not found.');
  db.prepare('DELETE FROM products WHERE id = ?').run(ex.id); removeImage(ex.image);
  return { body: { ok: true } };
});

route('GET', '/api/admin/settings', async (req) => { requireAdmin(req); return { body: getSettings() }; });
route('PUT', '/api/admin/settings', async (req) => {
  requireAdmin(req);
  const b = await readJson(req);
  const clean = {
    shop_name: str(b.shop_name, 2, 60, 'Shop name'), tagline: optStr(b.tagline, 100, 'Tagline'),
    whatsapp: String(b.whatsapp || '').replace(/\D/g, ''), jazzcash: optStr(b.jazzcash, 30, 'JazzCash number'),
    easypaisa: optStr(b.easypaisa, 30, 'Easypaisa number'), account_name: optStr(b.account_name, 80, 'Account name'),
    delivery_fee: int(b.delivery_fee, 0, 100000, 'Delivery fee'), free_delivery_over: int(b.free_delivery_over, 0, 100000000, 'Free delivery amount'),
    announcement: optStr(b.announcement, 160, 'Announcement')
  };
  if (clean.whatsapp && !/^\d{11,15}$/.test(clean.whatsapp)) throw new HttpError(400, 'WhatsApp number must include the country code, for example 923001234567.');
  setSettings(clean); return { body: { ok: true } };
});

// ---- static files -------------------------------------------------------
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
};
function serveStatic(req, res, urlPath) {
  let root = PUBLIC_DIR, rel = urlPath;
  if (urlPath.startsWith('/uploads/')) { root = UPLOAD_DIR; rel = urlPath.slice('/uploads'.length); }
  else if (urlPath === '/') rel = '/index.html';
  else if (urlPath === '/admin') rel = '/admin.html';
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root + path.sep)) return send(res, 403, 'Forbidden', SEC_HEADERS);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found', SEC_HEADERS);
    const ext = path.extname(file).toLowerCase();
    const cache = root === UPLOAD_DIR ? 'public, max-age=2592000, immutable' : ext === '.html' ? 'no-cache' : 'public, max-age=300';
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': cache, ...SEC_HEADERS });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// ---- server -----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let p; try { p = decodeURIComponent(url.pathname); } catch { throw new HttpError(400, 'Bad URL.'); }
    if (p.startsWith('/api/') || p === '/healthz') {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(p); if (!m) continue;
        if (req.method !== 'GET' && p.startsWith('/api/admin/') && p !== '/api/admin/login' && !isAdmin(req)) throw new HttpError(401, 'Please sign in.');
        const out = await r.handler(req, url, m);
        return send(res, out.status || 200, out.body, { ...SEC_HEADERS, ...(out.headers || {}) });
      }
      throw new HttpError(404, 'Not found.');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
    serveStatic(req, res, p);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e instanceof HttpError ? e.message : 'Something went wrong. Please try again.' }, SEC_HEADERS);
  }
});
server.listen(PORT, () => console.log(`Store running on http://localhost:${PORT}  (admin: /admin)`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => { try { db.close(); } catch (_) {} process.exit(0); }));

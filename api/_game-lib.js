// v83: entrega automática con el proveedor de recargas. Todo sale de variables de entorno (CO_API_BASE, CO_API_KEY, CO_WEBHOOK_SECRET)
// y de Supabase (tabla kiwi_prov_items: qué producto del proveedor corresponde a cada producto de Kiwii).
// Acá NO van nombres, URLs, códigos de producto ni costos del proveedor (el repo es público).
const crypto = require('crypto');
const env = k => String(process.env[k] || '').trim();

const MARGIN = 1.10;      // margen por defecto (10%) solo si un producto no está en MARGINS
const MARGINS = {
  5: 20, 6: 18, 7: 16, 8: 14, 9: 12, 10: 10,
  1: 20, 2: 16.5, 4: 13.5, 3: 10,
  23: 20, 25: 18, 26: 16, 27: 14, 28: 12, 29: 10,
  30: 20, 31: 16.5, 32: 13.5, 33: 10,
  34: 20, 35: 18, 36: 16, 37: 14, 38: 12, 39: 10,
  249: 20, 250: 19, 251: 18, 252: 16.5, 253: 15.5, 254: 14.5, 255: 13.5, 256: 12, 257: 11, 258: 10,
  259: 20, 261: 18, 262: 17.5, 263: 16.5, 265: 14.5, 266: 13.5, 267: 12.5, 268: 12, 269: 11, 270: 10
};
// v85: productos por cantidad (se arman con varios paquetes del proveedor en un solo pedido). Sin margen de respaldo:
// si la tabla no tiene su margen (sell_ratio) el producto queda no disponible.
// v87: mínimo / de a cuánto = el paquete más chico del proveedor que esté disponible (estos valores son solo el respaldo).
const BULK = {
  901: { kind: 'frag', label: 'Fragmentos Universales', min: 10, step: 10, max: 10000 },
  902: { kind: 'box', label: 'Cajas de Fragmentos', min: 1, step: 1, max: 1000 }
};
const isBulk = (id) => Object.prototype.hasOwnProperty.call(BULK, Number(id));
const IDS = Object.keys(MARGINS).map(Number).concat(Object.keys(BULK).map(Number));   // claves de producto de Kiwii con entrega automática
const NEEDS_ZONE = new Set(IDS.filter(id => id >= 249 && id <= 270));
// v87: productos nuevos (claves 1001–1999). Se configuran SOLO en Supabase (kiwi_prov_items: producto, categoría, regla de precio).
const DYN_MIN = 1001, DYN_MAX = 1999;
const isDyn = (id) => Number.isInteger(Number(id)) && Number(id) >= DYN_MIN && Number(id) <= DYN_MAX;
const knownId = (id) => IDS.includes(Number(id)) || isDyn(id);
let DYN_IDS = [];                 // claves nuevas cargadas de la tabla
let META = {};                    // { id: { category, title } }
const allIds = () => IDS.concat(DYN_IDS.filter(k => !IDS.includes(k)));
const CATEGORY_OF = (pid) => (META[pid] && META[pid].category) || (pid >= 900 && pid < 1000 ? 'freefire' : pid <= 10 ? 'freefire' : pid <= 33 ? 'bloodstrike' : pid <= 39 ? 'pubg' : pid <= 270 ? 'mlbb' : 'otros');
// v87: regla de precio por tramo de costo (misma escala que Free Fire y los demás: 20% de ganancia en lo más barato → 10% en lo más caro)
const TIERS = [[1, 1.20], [3, 1.18], [7, 1.16], [15, 1.14], [35, 1.12], [Infinity, 1.10]];
const tierRatio = (cost) => { const c = Number(cost); for (const [lim, r] of TIERS) if (c < lim) return r; return TIERS.length ? TIERS[TIERS.length - 1][1] : 1.10; };
// v95: el Owner puede cambiar los tramos en "Costos y márgenes" (kiwi_cost_settings.tiers: [{lt, pct}]). Si no son válidos, quedan los de arriba.
function setTiers(list) {
  if (!Array.isArray(list) || !list.length || list.length > 12) return false;
  const t = [];
  for (const e of list) {
    const lt = e && (e.lt === null || e.lt === undefined || e.lt === '') ? Infinity : Number(e && e.lt), pct = Number(e && e.pct);
    if (!(lt > 0) || !(pct >= 0 && pct <= 300)) return false;
    t.push([lt, Math.round((1 + pct / 100) * 1e6) / 1e6]);
  }
  t.sort((a, b) => a[0] - b[0]); if (t[t.length - 1][0] !== Infinity) t.push([Infinity, t[t.length - 1][1]]);
  TIERS.splice(0, TIERS.length, ...t); return true;
}
const TOLERANCE = 0.03;   // 3% de diferencia permitida entre el precio que vio el cliente y el actual
const CACHE_MS = 15 * 60 * 1000;                 // el catálogo del proveedor se cachea ~15 min

// v84: el margen de cada producto (y un tope opcional de precio) vienen de Supabase (kiwi_prov_items.sell_ratio / price_cap).
// MARGINS queda solo como respaldo si la tabla todavía no tiene esos datos.
const MIN_RATIO = 1.05;   // con tope: nunca menos de 5% de ganancia sobre el costo
let RULES = {};           // { id: { ratio, cap } }
function setRules(items) {
  const r = {};
  for (const [k, it] of Object.entries(items || {})) {
    const ratio = Number(it.ratio), cap = Number(it.cap);
    const ucap = it.bulk && Number(it.bulk.unit_cap);
    r[k] = { ratio: ratio >= 1 && ratio <= 3 ? ratio : null, cap: isBulk(k) ? (ucap > 0 ? ucap : null) : (cap > 0 ? cap : null), tier: it.rule === 'tier' };
  }
  RULES = r;
}
// v95: regla de precio de un producto (para el panel del Owner)
const ruleOf = (id) => { const r = RULES[id]; if (!r) return null; return r.tier ? 'tier' : (r.ratio ? 'pct' : null); };
const ceil2 = (x) => Math.ceil(Math.round(x * 1e6) / 1e4 - 1e-9) / 100;
const ceil6 = (x) => Math.ceil(Math.round(x * 1e8) / 100 - 1e-9) / 1e6;
const marginOf = (id, cost) => {
  if (RULES[id] && RULES[id].tier && Number(cost) > 0) return tierRatio(cost);   // v87: por tramo de costo
  const rr = RULES[id] && RULES[id].ratio; if (rr) return rr;
  const p = Number(MARGINS[id]); return p >= 0 && p <= 200 ? 1 + p / 100 : MARGIN;
};
const salePrice = (cost, id) => {
  let p = ceil2(cost * (id != null ? marginOf(id, cost) : MARGIN));
  const cap = id != null && RULES[id] && RULES[id].cap;
  if (cap && p > cap) p = Math.max(cap, ceil2(cost * MIN_RATIO));   // no subir el precio por encima del tope (salvo para mantener el 5%)
  return p;
};
const RESELLER_FACTOR = { 1: 0.5, 2: 0.25 };
const resellerSalePrice = (cost, id, level) => {
  const f = RESELLER_FACTOR[level];
  if (!f) return salePrice(cost, id);
  const eff = cost > 0 ? salePrice(cost, id) / cost : (id != null ? marginOf(id, cost) : MARGIN);   // margen real (con tope incluido)
  return Math.min(salePrice(cost, id), ceil2(cost * (1 + (eff - 1) * f)));
};

// v85: precio por unidad de los productos por cantidad (costo por unidad = el más caro entre los paquetes → nunca se pierde)
function bulkUnit(unitCost, id, level) {
  const ratio = RULES[id] && RULES[id].ratio; if (!(ratio && unitCost > 0)) return null;
  let u = ceil6(unitCost * ratio);
  const cap = RULES[id].cap; if (cap && u > cap) u = Math.max(cap, ceil6(unitCost * MIN_RATIO));
  const f = RESELLER_FACTOR[level]; if (!f) return u;
  return Math.min(u, ceil6(unitCost * (1 + (u / unitCost - 1) * f)));
}
const bulkPrice = (unitCost, id, qty, level) => { const u = bulkUnit(unitCost, id, level); return u ? ceil2(qty * u) : null; };
// v87: reglas de cantidad según los paquetes disponibles: mínimo = paquete más chico, de a = MCD de los tamaños, máximo = stock
const gcd = (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a; };
function bulkRules(id, packs) {
  const B = BULK[id]; if (!B) return null;
  const ps = (packs || []).filter(p => p && p.size > 0 && p.cost > 0 && !(p.stock === 0));
  if (!ps.length) return { min: B.min, step: B.step, max: B.max };
  const min = Math.min(...ps.map(p => p.size));
  const step = ps.map(p => p.size).reduce(gcd);
  let max = B.max;
  if (ps.every(p => Number.isFinite(p.stock))) max = Math.min(max, ps.reduce((t, p) => t + p.size * p.stock, 0));
  max = Math.floor(max / step) * step;
  return { min, step, max: Math.max(max, 0) };
}
function qtyError(id, qty, rules) {
  const b = rules || BULK[id]; if (!b || !BULK[id]) return 'Producto inválido.';
  if (b.max < b.min) return 'Sin stock suficiente por ahora.';
  if (!Number.isInteger(qty) || qty < b.min) return 'La cantidad mínima es ' + b.min + '.';
  if (qty > b.max) return 'La cantidad máxima es ' + b.max + '.';
  if (qty % b.step) return 'La cantidad tiene que ser múltiplo de ' + b.step + '.';
  return null;
}
// Arma el pedido con los paquetes más grandes primero. Devuelve { lines: [{ref, n, size}], cost } o null si no se puede.
function bulkPlan(packs, qty) {
  const ps = (packs || []).filter(p => p.ref && p.size > 0 && p.cost > 0 && !(p.stock === 0)).sort((a, b) => b.size - a.size);
  let left = qty, cost = 0; const lines = [];
  for (const p of ps) { const n = Math.min(Math.floor(left / p.size), Number.isFinite(p.stock) ? p.stock : Infinity); if (n > 0) { lines.push({ ref: p.ref, n, size: p.size }); cost += n * p.cost; left -= n * p.size; } }
  return left === 0 && lines.length ? { lines, cost: Math.round(cost * 1e4) / 1e4 } : null;
}

// ---------- HTTP ----------
let _fetch = (...a) => fetch(...a);
function _setFetch(f) { _fetch = f || ((...a) => fetch(...a)); }
async function fetchJson(url, opts, ms) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms || 20000);
  try {
    const r = await _fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
    const text = await r.text();
    let json; try { json = text ? JSON.parse(text) : {}; } catch (_) { json = { raw: String(text).slice(0, 300) }; }
    const ra = r.headers && typeof r.headers.get === 'function' ? Number(r.headers.get('retry-after')) : NaN;
    return { ok: r.ok, status: r.status, json, retryAfter: Number.isFinite(ra) ? ra : null };
  } finally { clearTimeout(t); }
}

// ---------- Supabase (service role: solo servidor) ----------
const SB_URL = () => (env('SUPABASE_URL') || 'https://ykxyiamlvlppcyfzyvzr.supabase.co').replace(/\/$/, '');
async function sb(fn, args, ms) {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!key) throw new Error('Falta SUPABASE_SERVICE_ROLE_KEY');
  const r = await fetchJson(SB_URL() + '/rest/v1/rpc/' + fn, { method: 'POST', headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(args || {}) }, ms || 10000);
  if (!r.ok) throw new Error(String((r.json && (r.json.message || r.json.error)) || ('Supabase ' + r.status)).slice(0, 300));
  return r.json;
}
const sbSoft = (fn, args, ms) => sb(fn, args, ms || 4000).catch(() => null);

// ---------- Proveedor ----------
const provBase = () => env('CO_API_BASE').replace(/\/+$/, '');
const provKey = () => env('CO_API_KEY');
const provReady = () => !!(provBase() && provKey());
// Devuelve { ok, status, json, code, message, retryAfter }. Nunca tira excepción (los cortes de red vuelven como code 'network').
async function prov(path, opts) {
  opts = opts || {};
  if (!provReady()) return { ok: false, status: 0, code: 'not_configured', message: 'Faltan CO_API_BASE / CO_API_KEY' };
  const headers = { Authorization: 'Bearer ' + provKey(), Accept: 'application/json' };
  if (opts.body) headers['Content-Type'] = 'application/json';
  if (opts.idem) headers['Idempotency-Key'] = opts.idem;
  try {
    const r = await fetchJson(provBase() + path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined }, opts.ms || 20000);
    const e = r.json && r.json.error && typeof r.json.error === 'object' ? r.json.error : null;
    return Object.assign(r, { code: e ? String(e.code || '') : (r.ok ? null : 'http_' + r.status), message: e ? String(e.message || '').slice(0, 200) : null });
  } catch (e) {
    return { ok: false, status: 0, code: 'network', message: String(e && e.message || e).slice(0, 200) };
  }
}

// ---------- Catálogo / costos (con caché, memoria en Supabase si el proveedor no responde) ----------
let cache = null, inflight = null, lastSynced = null;
async function loadItems() {
  const r = await sb('kiwi_prov_items_get', {}, 6000);
  const items = {}, meta = {};
  for (const it of (Array.isArray(r) ? r : [])) {
    const k = Number(it.kiwi_key);
    if (knownId(k) && it.product_ref) items[k] = { ref: String(it.product_ref), fields: Array.isArray(it.fields) ? it.fields : [], pin: !!it.pin, snapshot: Number(it.snapshot_cost) || null, ratio: Number(it.sell_ratio) || null, cap: Number(it.price_cap) || null,
      bulk: it.bulk && typeof it.bulk === 'object' && Array.isArray(it.bulk.packs) ? it.bulk : null, rule: it.price_rule === 'tier' ? 'tier' : null };
    if (isBulk(k) && !(items[k].bulk && items[k].ratio)) delete items[k];   // por cantidad: sin paquetes o sin margen no se vende
    if (items[k] && isDyn(k) && !(items[k].ratio || items[k].rule)) delete items[k];   // v87: nuevo sin regla de precio → no se vende
    if (items[k] && (it.category || it.title)) meta[k] = { category: it.category ? String(it.category).slice(0, 30) : null, title: it.title ? String(it.title).slice(0, 120) : null };
  }
  try { const cr = await sbSoft('kiwi_cost_server_rules', {}, 3000); if (cr && cr.settings) setTiers(cr.settings.tiers); } catch (_) {}   // v95
  if (Object.keys(items).length) { setRules(items); DYN_IDS = Object.keys(items).map(Number).filter(isDyn).sort((a, b) => a - b); META = meta; }
  return items;
}
async function loadLive() {
  const items = await loadItems();
  if (!Object.keys(items).length) throw new Error('sin productos configurados (kiwii-v83.sql)');
  const r = await prov('/catalog', { ms: 15000 });
  if (!r.ok) throw new Error('catálogo ' + (r.code || r.status));
  const list = Array.isArray(r.json && r.json.items) ? r.json.items : null;
  if (!list || !list.length) throw new Error('catálogo vacío');
  const byRef = new Map(list.map(p => [String(p.product_id), p]));
  const costs = {}, inactive = [], schemas = {}, packs = {};
  const stockOf = (p) => (p.available_stock == null || p.available_stock === '' || !Number.isFinite(Number(p.available_stock))) ? null : Math.max(0, Math.floor(Number(p.available_stock)));
  for (const id of allIds()) {
    if (isBulk(id)) {   // v87: se usan los paquetes disponibles (con su stock); costo por unidad = el más caro entre ellos
      const it = items[id]; const ps = [];
      for (const k of (it ? it.bulk.packs : [])) {
        const p = byRef.get(String(k.ref)), c = p ? Number(p.reseller_price) : NaN, size = Number(k.size);
        if (p && String(k.ref) === it.ref && Array.isArray(p.target_schema) && p.target_schema.length) schemas[id] = p.target_schema;
        if (!p || String(p.status || 'active') !== 'active' || p.in_stock === false || stockOf(p) === 0 || !(c > 0 && c < 10000) || !(size > 0)) continue;
        ps.push({ ref: String(k.ref), size, cost: c, stock: stockOf(p) });
        if (!schemas[id] && Array.isArray(p.target_schema) && p.target_schema.length) schemas[id] = p.target_schema;
      }
      if (!ps.length) { inactive.push(id); continue; }
      packs[id] = ps; costs[id] = Math.max(...ps.map(p => p.cost / p.size));
      continue;
    }
    const it = items[id], p = it && byRef.get(it.ref);
    const c = p ? Number(p.reseller_price) : NaN;
    if (!p || String(p.status || 'active') !== 'active' || p.in_stock === false || stockOf(p) === 0 || !(c > 0 && c < 10000)) { inactive.push(id); continue; }
    costs[id] = Math.round(c * 1e4) / 1e4;
    if (Array.isArray(p.target_schema)) schemas[id] = p.target_schema;
  }
  return { at: Date.now(), costs, inactive, schemas, items, packs, live: true, source: 'live' };
}
async function persist(d) {
  const sig = JSON.stringify(d.costs);
  if (sig === lastSynced) return;
  const r = await sbSoft('kiwi_ra_costs_sync', { p_costs: d.costs });
  if (r !== null) lastSynced = sig;
}
async function loadPersisted() {
  const items = await loadItems().catch(() => ({}));
  const r = await sbSoft('kiwi_ra_costs_get', {});
  const rows = Array.isArray(r) ? r : [];
  const db = {}; let at = 0;
  for (const row of rows) { const id = Number(row.ra_id), c = Number(row.cost); if (c > 0) { db[id] = c; at = Math.max(at, Date.parse(row.updated_at) || 0); } }
  const costs = {}, inactive = [], packs = {};
  for (const id of allIds()) {
    const it = items[id];
    const c = Math.max(Number(db[id]) || 0, (it && it.snapshot) || 0);   // conservador: el mayor entre lo guardado y la foto del SQL
    if (!it || !(c > 0)) { inactive.push(id); continue; }
    costs[id] = c;
    if (isBulk(id)) packs[id] = it.bulk.packs.map(p => ({ ref: String(p.ref), size: Number(p.size), cost: Math.max(Number(p.cost) || 0, Number(p.size) * c) }));
  }
  return Object.keys(costs).length ? { at: at || Date.now(), costs, inactive, schemas: {}, items, packs } : null;
}
async function getCosts(opts) {
  opts = opts || {};
  if (!opts.force && cache && Date.now() - cache.at < CACHE_MS) return cache;
  if (!inflight) inflight = loadLive().then(async d => { cache = d; try { await persist(d); } catch (_) {} return d; }, () => null).finally(() => { inflight = null; });
  const d = await inflight;
  if (d) return d;
  if (cache) return Object.assign({}, cache, { live: false, stale: true, source: 'cache' });
  const db = await loadPersisted().catch(() => null);
  if (db) return Object.assign(db, { live: false, stale: true, source: 'db' });
  return { at: Date.now(), costs: {}, inactive: allIds(), schemas: {}, items: {}, packs: {}, live: false, stale: true, source: 'fallback' };
}
async function recentChanges(limit) {
  const r = await sbSoft('kiwi_ra_price_changes_recent', { p_limit: limit || 30 });
  return Array.isArray(r) ? r : [];
}
function _resetCache() { cache = null; inflight = null; lastSynced = null; _bal = null; RULES = {}; DYN_IDS = []; META = {}; pvMem.clear(); pvUnsupported.clear(); pvCalls.length = 0; pvCool = 0; }

// target_payload a partir del esquema del producto (los "select" usan el value de la opción)
function buildTarget(fields, schema, player, zone) {
  const sch = Array.isArray(schema) && schema.length ? schema : (fields || []).map(k => ({ key: k, type: 'text' }));
  if (!sch.length) return { payload: {} };
  const out = {};
  for (const f of sch) {
    const k = String(f && f.key || ''); if (!k) continue;
    const isZone = /zone|server|servidor|region/i.test(k);
    let v = String(isZone ? (zone || '') : (player || '')).trim();
    if (!v) return { error: isZone ? 'Falta la Zona / Servidor.' : 'Falta el ID de jugador.' };
    if (f.type === 'select' && Array.isArray(f.options) && f.options.length) {
      const o = f.options.find(o => String(o.value) === v) || f.options.find(o => String(o.label || '').trim().toLowerCase() === v.toLowerCase());
      if (!o) return { error: 'Zona / Servidor no válido para este producto.' };
      v = String(o.value);
    }
    out[k] = v;
  }
  return { payload: out };
}

// ---------- Telegram (mismo bot de avisos: TG_BOT_TOKEN + TG_CHAT_ID) ----------
async function tg(text) {
  if (!env('TG_BOT_TOKEN') || !env('TG_CHAT_ID')) return false;
  try {
    const r = await fetchJson('https://api.telegram.org/bot' + env('TG_BOT_TOKEN') + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env('TG_CHAT_ID'), text: String(text).slice(0, 3900), parse_mode: 'HTML', disable_web_page_preview: true }) }, 8000);
    return !!r.ok;
  } catch (_) { return false; }
}
const tgEsc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// ---------- Saldo del proveedor (caché 30 s) ----------
let _bal = null;
async function provBalance(force) {
  if (!force && _bal && Date.now() - _bal.at < 30000) return _bal.v;
  const r = await prov('/balance', { ms: 8000 });
  if (!r.ok || !r.json) return null;
  const v = { available: Number(r.json.available_balance), held: Number(r.json.held_balance), total: Number(r.json.total_balance), currency: r.json.currency || 'USD' };
  _bal = { at: Date.now(), v }; return v;
}

// ---------- Pedidos en el proveedor ----------
const FAIL_ITEM = /^(failed|refunded|cancelled|canceled)$/i;
const FAIL_ORDER = /^(failed|cancelled|canceled)$/i;
const MAX_SUBMITS = 8;
// Próxima revisión: cada 30 s los primeros 5 min desde el envío, después cada 5 min
const nextIn = (rec) => { const t0 = Date.parse(rec && rec.submitted_at) || Date.now(); return Date.now() - t0 < 5 * 60 * 1000 ? 30 : 300; };

async function patch(rec, p) { const r = await sb('kiwi_prov_order_patch', { p_order_id: rec.order_id, p_patch: p }); return r || rec; }
async function alertOnce(rec, kind, text) {
  if (rec.last_alert === kind) return rec;
  await tg(text);
  return patch(rec, { last_alert: kind });
}
const orderLine = rec => '#' + tgEsc(rec.order_id) + ' · ' + tgEsc(rec.title || ('producto ' + rec.kiwi_key)) + ' · ' + tgEsc(rec.username);

async function toManual(rec, why, kind) {
  rec = await patch(rec, { status: 'manual', last_error: why });
  return alertOnce(rec, kind || 'manual', '⚠️ <b>Entrega automática pendiente (manual)</b>\n' + orderLine(rec) + '\nMotivo: ' + tgEsc(why) + '\nEl cliente YA pagó: cargalo a mano o cancelalo (devuelve el saldo) desde el panel.');
}
async function refund(rec, why) {
  const r = await sb('kiwi_prov_refund', { p_order_id: rec.order_id, p_reason: why });
  const fresh = (await sbSoft('kiwi_prov_order_get', { p_key: rec.order_id })) || rec;
  if (r && r.skipped) await alertOnce(fresh, 'refund-skipped', '⚠️ <b>Falló en el proveedor</b> pero el pedido figura entregado: revisalo.\n' + orderLine(rec) + '\n' + tgEsc(why));
  else if (r && r.ok && !r.already) await tg('↩️ <b>Recarga automática fallida → saldo devuelto</b>\n' + orderLine(rec) + '\nDevuelto: ' + Number(r.refunded || 0).toFixed(2) + ' USDT\nMotivo: ' + tgEsc(why));
  return Object.assign(fresh, { _refund: r });
}
async function deliver(rec, order) {
  let codes = null;
  if (rec.pin || (order && order.items && order.items.some(i => i.product_type === 'gift_card' || i.has_codes))) {
    const c = await prov('/orders/' + encodeURIComponent(rec.prov_order_id) + '/codes', { ms: 15000 });
    if (!c.ok) return patch(rec, { last_error: 'códigos: ' + (c.code || c.status), next_in_s: 60, inc_checks: true });   // reintenta después
    codes = [];
    for (const it of (c.json && Array.isArray(c.json.items) ? c.json.items : [])) for (const x of (Array.isArray(it.codes) ? it.codes : [])) {
      const s = typeof x === 'string' ? x : [x.code || x.pin, x.serial].filter(Boolean).join(' - ');
      if (s) codes.push(String(s).slice(0, 300));
    }
    if (!codes.length) return patch(rec, { last_error: 'sin códigos todavía', next_in_s: 60, inc_checks: true });
  }
  const dv = await sb('kiwi_prov_deliver', { p_order_id: rec.order_id, p_codes: codes });
  if (codes && codes.length && !(dv && dv.already)) {   // v87: aviso al staff de que se entregó un código (enmascarado)
    const mask = c => { const t = String(c).replace(/\s+/g, ''); return t.length <= 6 ? '•••' + t.slice(-2) : t.slice(0, 3) + '•••' + t.slice(-3); };
    await tg('🎁 <b>Código entregado automáticamente</b>\n' + orderLine(rec) + '\n' + codes.map(c => tgEsc(mask(c))).join('\n') + '\nEl cliente lo ve en Mis pedidos.');
  }
  return Object.assign((await sbSoft('kiwi_prov_order_get', { p_key: rec.order_id })) || rec, { status: 'completed', codes });
}
function failReason(order, item) {
  const f = (item && item.failure) || (order && order.failure) || {};
  return String(f.message_es || f.message || f.code || (item && item.status) || (order && order.status) || 'falló').slice(0, 200);
}
async function applyOrder(rec, order) {
  const items = Array.isArray(order.items) ? order.items : [];
  if (items.length > 1 || String(order.status || '').toLowerCase() === 'partially_completed') {   // v85: varios paquetes
    const sts = items.map(i => String(i && i.status || '').toLowerCase());
    const ok = sts.filter(x => x === 'completed').length, bad = sts.filter(x => FAIL_ITEM.test(x)).length;
    if (items.length && ok === items.length) return deliver(rec, order);
    if (items.length && bad === items.length) return refund(rec, failReason(order, items.find(i => i && i.failure) || items[0]));
    if (items.length && ok + bad === items.length)
      return toManual(rec, 'Entrega parcial: ' + ok + ' de ' + items.length + ' paquetes entregados. Devolvé la parte que falta desde el panel.', 'partial');
    if (!items.length && String(order.status || '').toLowerCase() === 'partially_completed') return toManual(rec, 'Entrega parcial en el proveedor', 'partial');
    return patch(rec, { status: 'processing', item_status: (ok + '/' + items.length + ' ok'), next_in_s: nextIn(rec), inc_checks: true });
  }
  const item = items[0] || null;
  const st = String((item && item.status) || order.status || '').toLowerCase();
  const ost = String(order.status || '').toLowerCase();
  if (st === 'completed' || (ost === 'completed' && !item)) return deliver(rec, order);
  if (FAIL_ITEM.test(st) || (!item && FAIL_ORDER.test(ost)) || (FAIL_ORDER.test(ost) && !/^completed$/.test(st))) return refund(rec, failReason(order, item));
  return patch(rec, { status: 'processing', item_status: st || ost, next_in_s: nextIn(rec), inc_checks: true });
}

// Enviar el pedido (idempotente: la misma Idempotency-Key devuelve el mismo pedido aunque se repita)
async function submit(rec) {
  rec = await patch(rec, { inc_submits: true, submitted_at: true });
  const lines = Array.isArray(rec.lines) && rec.lines.length ? rec.lines : [{ ref: rec.product_ref, n: 1 }];
  const body = { items: lines.map(l => ({ catalog_item_id: String(l.ref), quantity: Math.max(1, Number(l.n) || 1), target_payload: rec.target || {} })), note: 'kiwi ' + String(rec.order_id).slice(0, 60) };
  const r = await prov('/orders', { method: 'POST', body, idem: rec.idem_key, ms: 25000 });
  const o = r.json && r.json.order;
  if (r.ok && o && o.id) {
    rec = await patch(rec, { status: 'submitted', prov_order_id: String(o.id), prov_ref: String(o.reference_code || ''), item_status: String(o.status || ''),
                             cost: o.total_sale_amount != null ? String(o.total_sale_amount) : undefined, last_error: null, next_in_s: 0 });
    if (/^(completed|failed|cancelled|canceled|partially_completed)$/i.test(String(o.status || '')) || Array.isArray(o.items)) return applyOrder(rec, o);
    return patch(rec, { next_in_s: 30 });
  }
  const code = String(r.code || '');
  if (code === 'insufficient_balance') return toManual(rec, 'Saldo insuficiente en el proveedor', 'balance');
  if (code === 'insufficient_stock') return toManual(rec, 'Sin stock en el proveedor', 'stock');
  if (code === 'invalid_request' || r.status === 404) return refund(rec, 'Datos rechazados por el proveedor' + (r.message ? ': ' + r.message : ''));   // no se creó: se devuelve
  if (code === 'invalid_api_key' || code === 'insufficient_scope' || code === 'not_configured' || code === 'idempotency_key_reused' || r.status === 401 || r.status === 403 || r.status === 422)
    return toManual(rec, 'Configuración del proveedor: ' + (code || r.status), 'config');
  // rate_limited / maintenance_mode / service_unavailable / 5xx / red: reintentar con la MISMA clave
  if ((rec.submits || 0) >= MAX_SUBMITS) return toManual(rec, 'No se pudo enviar (' + (code || r.status) + ') tras ' + rec.submits + ' intentos', 'retries');
  const wait = Math.max(30, Math.min(1800, Number(r.retryAfter) || (code === 'maintenance_mode' ? 600 : 60)));
  rec = await patch(rec, { status: 'retry', last_error: code || ('HTTP ' + r.status), next_in_s: wait });
  if (code === 'maintenance_mode') await alertOnce(rec, 'maintenance', '🛠️ Proveedor en mantenimiento: el pedido ' + orderLine(rec) + ' se reintenta solo.');
  return rec;
}
async function refresh(rec) {
  if (!rec.prov_order_id) return submit(rec);
  const r = await prov('/orders/' + encodeURIComponent(rec.prov_order_id), { ms: 15000 });
  if (r.ok && r.json && (r.json.order || r.json.id)) return applyOrder(rec, r.json.order || r.json);
  const wait = r.status === 429 ? Math.max(60, Number(r.retryAfter) || 60) : nextIn(rec);
  return patch(rec, { last_error: 'consulta: ' + (r.code || r.status), next_in_s: wait, inc_checks: true });
}
// Procesa un pedido según su estado. force = ignorar el horario de la próxima revisión (webhook / staff)
async function processOrder(rec, force) {
  if (!rec) return rec;
  const due = force || !rec.next_check_at || Date.parse(rec.next_check_at) <= Date.now() + 500;
  if (!due) return rec;
  if (rec.status === 'new' || rec.status === 'retry') {
    if (['cancelled', 'delivered', 'accredited'].includes(String(rec.compra_status || ''))) return rec;   // el staff ya lo resolvió a mano
    return submit(rec);
  }
  if (rec.status === 'submitted' || rec.status === 'processing') {
    if (Date.now() - (Date.parse(rec.submitted_at) || Date.now()) > 48 * 3600 * 1000) return toManual(rec, 'Sin respuesta final del proveedor en 48 h', 'stale');
    return refresh(rec);
  }
  return rec;
}
async function sweep(limit) {
  const list = await sbSoft('kiwi_prov_due', { p_limit: limit || 5 }, 6000);
  const out = [];
  for (const rec of (Array.isArray(list) ? list : [])) { try { const x = await processOrder(rec); out.push({ id: rec.order_id, status: x && x.status }); } catch (e) { out.push({ id: rec.order_id, error: String(e.message || e).slice(0, 120) }); } }
  return out;
}
// ---------- v87: verificación de ID de jugador (caché + límites; el proveedor permite pocas consultas por minuto) ----------
const PV_TTL = { valid: 6 * 3600e3, invalid: 10 * 60e3, unverified: 10 * 60e3 };
const PV_LIMITS = { ipMin: 6, ipHour: 40, globalMin: 25 };      // por IP: 6/min y 40/h · total: 25/min (el proveedor permite 30/min)
const pvMem = new Map(), pvUnsupported = new Map(), pvCalls = [];
let pvCool = 0;                                               // si el proveedor responde 429, se espera lo que pida
const pvKey = (ref, payload) => crypto.createHash('sha256').update(String(ref) + '|' + JSON.stringify(Object.keys(payload || {}).sort().map(k => [k, String(payload[k])]))).digest('hex').slice(0, 40);
const ipHash = (ip) => ip ? crypto.createHash('sha256').update('kiwi-pv|' + ip).digest('hex').slice(0, 32) : 'sin-ip';
function clientIp(headers) { const h = headers || {}; return String(h['x-real-ip'] || h['x-forwarded-for'] || '').split(',')[0].trim().slice(0, 64); }
function memGate(iph) {
  const now = Date.now(); while (pvCalls.length && now - pvCalls[0].t > 3600e3) pvCalls.shift();
  const mine = pvCalls.filter(c => c.ip === iph);
  if (mine.filter(c => now - c.t < 60e3).length >= PV_LIMITS.ipMin || mine.length >= PV_LIMITS.ipHour) return { allow: false, reason: 'ip' };
  if (pvCalls.filter(c => now - c.t < 60e3).length >= PV_LIMITS.globalMin) return { allow: false, reason: 'global' };
  pvCalls.push({ ip: iph, t: now }); return { allow: true };
}
function pvRemember(k, ref, st, name, unsupported) {
  const now = Date.now();
  if (unsupported) pvUnsupported.set(String(ref), now + 12 * 3600e3);
  pvMem.set(k, { status: st, name, exp: now + (PV_TTL[st] || PV_TTL.unverified) });
  if (pvMem.size > 3000) pvMem.delete(pvMem.keys().next().value);
}
// Devuelve { status: 'valid' | 'invalid' | 'unverified', name, unsupported?, throttled?, cached? }. Nunca tira excepción.
async function verifyPlayer(ref, payload, ip) {
  const now = Date.now(), k = pvKey(ref, payload), iph = ipHash(ip);
  const u = pvUnsupported.get(String(ref)); if (u && u > now) return { status: 'unverified', name: null, unsupported: true, cached: true };
  const m = pvMem.get(k); if (m && m.exp > now) return { status: m.status, name: m.name, cached: true };
  if (pvCool > now) return { status: 'unverified', name: null, throttled: 'global' };
  let gate = await sbSoft('kiwi_pv_take', { p_key: k, p_ref: String(ref), p_ip: iph, p_ip_min: PV_LIMITS.ipMin, p_ip_hour: PV_LIMITS.ipHour, p_global_min: PV_LIMITS.globalMin });
  if (gate && gate.hit && gate.hit.status) {
    const st = String(gate.hit.status), name = gate.hit.name ? String(gate.hit.name).slice(0, 80) : null;
    pvRemember(k, ref, st, name, !!gate.hit.unsupported);
    return { status: st, name, unsupported: !!gate.hit.unsupported, cached: true };
  }
  if (!gate || typeof gate !== 'object' || gate.allow == null) gate = memGate(iph);   // sin SQL v87: límites en memoria
  if (!gate.allow) return { status: 'unverified', name: null, throttled: gate.reason || 'ip' };
  const r = await prov('/player/validate', { method: 'POST', body: { product_id: ref, target_payload: payload }, ms: 10000 });
  if (!r.ok || !r.json) {
    if (r.status === 429) pvCool = Date.now() + Math.max(10, Math.min(120, Number(r.retryAfter) || 60)) * 1000;
    return { status: 'unverified', name: null, error: true };
  }
  let st = String(r.json.status || 'unverified').toLowerCase(); if (!['valid', 'invalid', 'unverified'].includes(st)) st = 'unverified';
  const unsupported = st === 'unverified' && /not_supported|unsupported/i.test(String(r.json.reason || ''));
  const name = st === 'valid' && r.json.player && r.json.player.name ? String(r.json.player.name).replace(/[<>]/g, '').trim().slice(0, 80) || null : null;
  pvRemember(k, ref, st, name, unsupported);
  await sbSoft('kiwi_pv_put', { p_key: k, p_ref: String(ref), p_status: st, p_name: name, p_unsupported: unsupported });
  return { status: st, name, unsupported };
}

// Estado neutral para el cliente
function publicStatus(rec) {
  if (!rec) return 'unknown';
  if (rec.status === 'completed') return 'delivered';
  if (rec.status === 'refunded') return 'refunded';
  if (rec.status === 'manual') return 'manual';
  return 'processing';
}

// Webhook: firma HMAC-SHA256(secreto, timestamp + "." + cuerpo crudo) en un encabezado x-…-signature ("sha256=hex")
function headerLike(headers, rx) { for (const k of Object.keys(headers || {})) if (rx.test(k)) return String(headers[k] || ''); return ''; }
function verifyWebhook(headers, raw, secret, nowMs) {
  if (!secret || secret.length < 16) return { ok: false, why: 'sin secreto' };
  const sig = headerLike(headers, /^x-[a-z0-9]+-signature$/i).replace(/^sha256=/i, '').trim().toLowerCase();
  const ts = headerLike(headers, /^x-[a-z0-9]+-timestamp$/i).trim();
  if (!sig || !ts) return { ok: false, why: 'faltan encabezados' };
  let tms = Number(ts); if (!Number.isFinite(tms)) tms = Date.parse(ts); else if (tms < 1e12) tms *= 1000;
  if (!Number.isFinite(tms) || Math.abs((nowMs || Date.now()) - tms) > 5 * 60 * 1000) return { ok: false, why: 'vencido' };
  const exp = crypto.createHmac('sha256', secret).update(ts + '.' + raw).digest('hex');
  if (!/^[0-9a-f]{64}$/.test(sig) || !crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(exp, 'hex'))) return { ok: false, why: 'firma' };
  return { ok: true };
}

module.exports = { MARGIN, MARGINS, marginOf, TOLERANCE, IDS, NEEDS_ZONE, CATEGORY_OF, salePrice, resellerSalePrice, RESELLER_FACTOR,
  BULK, isBulk, bulkUnit, bulkPrice, bulkPlan, bulkRules, qtyError, isDyn, knownId, allIds, tierRatio, TIERS, setTiers, ruleOf, meta: (id) => META[id] || null,
  verifyPlayer, clientIp, ipHash, PV_LIMITS,
  getCosts, recentChanges, _resetCache, _setFetch, setRules, provReady, prov, provBalance, buildTarget, sb, sbSoft, tg, tgEsc,
  processOrder, submit, refresh, applyOrder, sweep, publicStatus, verifyWebhook, nextIn };

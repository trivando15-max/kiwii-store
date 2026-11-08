const RA_BASE = (process.env.INSTANT_API_BASE || process.env.RA_API_BASE || 'https://panel.recargasamerica.com/api/v1').replace(/\/+$/, '');
const MARGIN = 1.10;      // margen por defecto (10%) solo si un producto no está en MARGINS
const MARGINS = {
  5: 20, 6: 18, 7: 16, 8: 14, 9: 12, 10: 10,
  1: 20, 2: 16.5, 4: 13.5, 3: 10,
  23: 20, 25: 18, 26: 16, 27: 14, 28: 12, 29: 10,
  30: 20, 31: 16.5, 32: 13.5, 33: 10,
  34: 20, 35: 18, 36: 16, 37: 14, 38: 12, 39: 10,
  249: 20, 250: 19, 251: 18, 252: 16.5, 253: 15.5, 254: 14.5, 255: 13.5, 256: 12, 257: 11, 258: 10,
  259: 20, 260: 19, 261: 18, 262: 17.5, 263: 16.5, 264: 15.5, 265: 14.5, 266: 13.5, 267: 12.5, 268: 12, 269: 11, 270: 10
};
const TOLERANCE = 0.03;   // 3% de margen de diferencia entre el precio que vio el cliente y el actual
const CACHE_MS = 5 * 60 * 1000;

const FALLBACK = {
  5: 0.6494, 6: 1.9463, 7: 3.2918, 8: 6.1152, 9: 12.1364, 10: 30.8870, // Free Fire diamantes ilimitados (v39)
  1: 0.3535, 2: 1.5150, 3: 7.0700, 4: 2.1210,
  23: 0.7172, 25: 2.1515, 26: 3.5859, 27: 7.1693, 28: 14.3385, 29: 35.8488,
  30: 0.4293, 31: 1.6875, 32: 3.3898, 33: 7.4249,
  34: 0.8959, 35: 4.5090, 36: 9.0304, 37: 22.5873, 38: 45.1820, 39: 90.3764,
  249: 1.1539, 250: 1.4592, 251: 2.3103, 252: 3.4494, 253: 7.6209, 254: 9.2364,
  255: 27.7117, 256: 46.1870, 257: 69.2830, 258: 115.4725,
  259: 0.8586, 260: 1.7173, 261: 1.7173, 262: 4.2931, 263: 8.5862, 264: 8.5862,
  265: 17.1700, 266: 25.7562, 267: 42.9262, 268: 51.5100, 269: 68.6800, 270: 85.8500
};
const IDS = Object.keys(FALLBACK).map(Number);

function raKey() {
  return process.env.RA_API_KEY || process.env.RECARGAS_API_KEY || process.env.RECARGAS_AMERICA_API_KEY || process.env.RECARGAS_API_TOKEN || '';
}
const marginOf = (id) => { const p = Number(MARGINS[id]); return p >= 0 && p <= 200 ? 1 + p / 100 : MARGIN; };
const salePrice = (cost, id) => Math.ceil(Math.round(cost * (id != null ? marginOf(id) : MARGIN) * 1e6) / 1e4 - 1e-9) / 100;
const RESELLER_FACTOR = { 1: 0.5, 2: 0.25 };
const resellerSalePrice = (cost, id, level) => {
  const f = RESELLER_FACTOR[level];
  if (!f) return salePrice(cost, id);
  const m = 1 + ((id != null ? marginOf(id) : MARGIN) - 1) * f;
  return Math.ceil(Math.round(cost * m * 1e6) / 1e4 - 1e-9) / 100;
};

function isInactive(p) {
  if (!p) return true;
  if (p.active === false || p.is_active === false || p.enabled === false || p.available === false) return true;
  const st = String(p.status || p.state || '').toLowerCase();
  return /inactiv|disabled|unavailable|agotado|out_of_stock|paused/.test(st);
}

let cache = null; // { at, costs, inactive, live }
let inflight = null;

async function loadLive(fetchImpl) {
  const key = raKey();
  if (!key) throw new Error('sin clave');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await (fetchImpl || fetch)(RA_BASE + '/products/catalog', { method: 'GET', headers: { 'Authorization': 'Bearer ' + key, 'Accept': 'application/json' }, signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const list = Array.isArray(j && j.data) ? j.data : (j && j.data && Array.isArray(j.data.products) ? j.data.products : null);
    if (!list || !list.length) throw new Error('catálogo vacío');
    const byId = new Map(list.map(p => [Number(p.id != null ? p.id : p.product_id), p]));
    const costs = {}, inactive = [];
    for (const id of IDS) {
      const p = byId.get(id);
      const c = p ? Number(p.price != null ? p.price : p.cost) : NaN;
      if (!p || isInactive(p) || !(c > 0 && c < 10000)) { inactive.push(id); costs[id] = FALLBACK[id]; continue; }
      costs[id] = Math.round(c * 1e4) / 1e4;
    }
    return { at: Date.now(), costs, inactive, live: true, source: 'live' };
  } finally { clearTimeout(t); }
}

const SB_URL = () => (process.env.SUPABASE_URL || 'https://ykxyiamlvlppcyfzyvzr.supabase.co').replace(/\/$/, '');
async function sbRpc(fn, args, fetchImpl) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return null;
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await (fetchImpl || fetch)(SB_URL() + '/rest/v1/rpc/' + fn, { method: 'POST', headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(args || {}), signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) { return null; } finally { clearTimeout(t); }
}
let lastSynced = null;
async function persist(d, fetchImpl) {
  const sig = JSON.stringify(d.costs);
  if (sig === lastSynced) return;
  const costs = {}; for (const id of IDS) if (!(d.inactive || []).includes(id)) costs[id] = d.costs[id];
  const r = await sbRpc('kiwi_ra_costs_sync', { p_costs: costs }, fetchImpl);
  if (r !== null) lastSynced = sig;
}
async function loadPersisted(fetchImpl) {
  const r = await sbRpc('kiwi_ra_costs_get', {}, fetchImpl);
  const rows = Array.isArray(r) ? r : [];
  const costs = {}; let at = 0;
  for (const row of rows) { const id = Number(row.ra_id), c = Number(row.cost); if (IDS.includes(id) && c > 0) { costs[id] = c; at = Math.max(at, Date.parse(row.updated_at) || 0); } }
  return Object.keys(costs).length ? { costs, at } : null;
}
async function recentChanges(limit, fetchImpl) {
  const r = await sbRpc('kiwi_ra_price_changes_recent', { p_limit: limit || 30 }, fetchImpl);
  return Array.isArray(r) ? r : [];
}

async function getCosts(opts) {
  opts = opts || {};
  if (!opts.force && cache && Date.now() - cache.at < CACHE_MS) return cache;
  if (!inflight) inflight = loadLive(opts.fetch).then(async d => { cache = d; try { await persist(d, opts.fetch); } catch (_) {} return d; }, () => null).finally(() => { inflight = null; });
  const d = await inflight;
  if (d) return d;
  if (cache) return Object.assign({}, cache, { live: false, stale: true, source: 'cache' });
  const db = await loadPersisted(opts.fetch).catch(() => null);
  if (db) {
    const costs = {}; for (const id of IDS) costs[id] = Math.max(Number(db.costs[id]) || 0, FALLBACK[id]);
    return { at: db.at || Date.now(), costs, inactive: [], live: false, stale: true, source: 'db' };
  }
  return { at: Date.now(), costs: Object.assign({}, FALLBACK), inactive: [], live: false, stale: true, source: 'fallback' };
}
function _resetCache() { cache = null; inflight = null; lastSynced = null; }

module.exports = { RA_BASE, MARGIN, MARGINS, marginOf, TOLERANCE, FALLBACK, IDS, raKey, salePrice, resellerSalePrice, RESELLER_FACTOR, getCosts, recentChanges, _resetCache };

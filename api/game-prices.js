const lib = require('./_game-lib');

// v83: precios de la entrega automática (costo del proveedor × margen de cada producto). Público: solo precios de venta.
module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; return res.end(JSON.stringify({ success: false, error: 'Método no permitido' })); }
  const d = await lib.getCosts();
  res.statusCode = 200;
  if (d.source === 'fallback') { res.setHeader('Cache-Control', 'no-store'); return res.end(req.method === 'HEAD' ? '' : JSON.stringify({ success: false })); }
  res.setHeader('Cache-Control', d.live ? 'public, max-age=60, s-maxage=300, stale-while-revalidate=600' : 'public, max-age=30, s-maxage=60, stale-while-revalidate=120');
  const costs = {}, margins = {}, prices = {}, reseller_prices = {};
  const inactive = new Set((d.inactive || []).map(Number));
  for (const id of lib.IDS) {
    const c = Number(d.costs[id]);
    if (!(c > 0)) { inactive.add(id); continue; }
    costs[id] = c; margins[id] = Math.round((lib.marginOf(id) - 1) * 1000) / 10; prices[id] = lib.salePrice(c, id);
    reseller_prices[id] = [lib.resellerSalePrice(c, id, 1), lib.resellerSalePrice(c, id, 2)];
  }
  const adminKey = process.env.PRICES_ADMIN_KEY || process.env.RA_ADMIN_KEY || '', h = req.headers || {};
  const given = String(h['x-admin-key'] || h['x-ra-admin-key'] || '');
  const isAdmin = adminKey.length >= 12 && given.length === adminKey.length && require('crypto').timingSafeEqual(Buffer.from(given), Buffer.from(adminKey));
  const base = { success: true, prices, reseller_prices, inactive: [...inactive].sort((a, b) => a - b) };
  if (!isAdmin) return res.end(req.method === 'HEAD' ? '' : JSON.stringify(base));
  Object.assign(base, { costs, margins, margin: lib.MARGIN, live: !!d.live, source: d.source, stale: !!d.stale, updated_at: new Date(d.at).toISOString() });
  res.setHeader('Cache-Control', 'private, no-store');
  let changes = [];
  try {
    changes = (await lib.recentChanges(30)).map(c => {
      const id = Number(c.ra_id), nc = Number(c.new_cost), price = lib.IDS.includes(id) ? lib.salePrice(nc, id) : null;
      return { id, old_cost: Number(c.old_cost), new_cost: nc, new_price: price, margin_pct: price ? Math.round((price - nc) / nc * 1000) / 10 : null, changed_at: c.changed_at };
    });
  } catch (_) { changes = []; }
  const low = [], resellerLow = [];
  for (const id of Object.keys(costs).map(Number)) {
    const c = costs[id], m = (prices[id] - c) / c * 100, m2 = (lib.resellerSalePrice(c, id, 2) - c) / c * 100;
    if (m < 3) low.push({ id, cost: c, price: prices[id], margin_pct: Math.round(m * 10) / 10 });
    if (m2 < 3) resellerLow.push({ id, margin_pct: Math.round(m2 * 10) / 10 });
  }
  res.end(req.method === 'HEAD' ? '' : JSON.stringify(Object.assign(base, { changes, low_margin: low, reseller2_low_margin: resellerLow })));
};

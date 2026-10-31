// KIWII STORE v66 (antes v40) - GET /api/ra-prices : costos actuales de Recargas América (solo productos permitidos, nunca la clave)
const lib = require('./_ra-lib');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; return res.end(JSON.stringify({ success: false, error: 'Método no permitido' })); }
  const d = await lib.getCosts();
  res.statusCode = 200;
  res.setHeader('Cache-Control', d.live ? 'public, max-age=60, s-maxage=300, stale-while-revalidate=600' : 'public, max-age=30, s-maxage=60, stale-while-revalidate=120');
  const costs = {}, margins = {}, prices = {};
  for (const id of lib.IDS) { costs[id] = d.costs[id]; margins[id] = Math.round((lib.marginOf(id) - 1) * 1000) / 10; prices[id] = lib.salePrice(d.costs[id], id); }
  // v66: cambios de costo registrados en Supabase (kiwi_ra_price_changes) con el precio de venta nuevo y el margen real
  let changes = [];
  try {
    changes = (await lib.recentChanges(30)).map(c => {
      const id = Number(c.ra_id), nc = Number(c.new_cost), price = lib.IDS.includes(id) ? lib.salePrice(nc, id) : null;
      return { ra_id: id, old_cost: Number(c.old_cost), new_cost: nc, new_price: price, margin_pct: price ? Math.round((price - nc) / nc * 1000) / 10 : null, changed_at: c.changed_at };
    });
  } catch (_) { changes = []; }
  // margen real a precio público con el costo actual (y en revendedor Nivel 2, el más chico)
  const low = [], resellerLow = [];
  for (const id of lib.IDS) {
    const c = d.costs[id], m = (prices[id] - c) / c * 100, m2 = (lib.resellerSalePrice(c, id, 2) - c) / c * 100;
    if (m < 3) low.push({ ra_id: id, cost: c, price: prices[id], margin_pct: Math.round(m * 10) / 10 });
    if (m2 < 3) resellerLow.push({ ra_id: id, margin_pct: Math.round(m2 * 10) / 10 });
  }
  res.end(JSON.stringify({ success: true, live: !!d.live, source: d.source || (d.live ? 'live' : 'fallback'), stale: !!d.stale, margin: lib.MARGIN, updated_at: new Date(d.at).toISOString(), costs, margins, prices, inactive: d.inactive || [], changes, low_margin: low, reseller2_low_margin: resellerLow }));
};

// KIWII STORE v40 - GET /api/ra-prices : costos actuales de Recargas América (solo productos permitidos, nunca la clave)
const lib = require('./_ra-lib');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; return res.end(JSON.stringify({ success: false, error: 'Método no permitido' })); }
  const d = await lib.getCosts();
  res.statusCode = 200;
  res.setHeader('Cache-Control', d.live ? 'public, max-age=60, s-maxage=300, stale-while-revalidate=600' : 'public, max-age=30, s-maxage=60, stale-while-revalidate=120');
  const costs = {}, margins = {}, prices = {};
  for (const id of lib.IDS) { costs[id] = d.costs[id]; margins[id] = Math.round((lib.marginOf(id) - 1) * 1000) / 10; prices[id] = lib.salePrice(d.costs[id], id); }
  res.end(JSON.stringify({ success: true, live: !!d.live, margin: lib.MARGIN, updated_at: new Date(d.at).toISOString(), costs, margins, prices, inactive: d.inactive || [] }));
};

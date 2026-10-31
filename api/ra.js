// KIWII STORE v60 - Proxy seguro para Recargas América (Vercel serverless, Node 18+, sin dependencias)
// Acciones (POST JSON):
//   { action:'validate', product_id, player_id, zone_id? }                -> verifica la cuenta (solo informativo)
//   { action:'buy', token, request_id, amount, reseller?:1, order:{id,title,price,date_str}, product_id, player_id, zone_id? }
//        1) cobra el saldo y guarda el pedido en Supabase en UN paso (kiwi_checkout, con el token del cliente)
//        2) recién después compra en Recargas América con Idempotency-Key = "kiwii-<id del pedido>"
//   { action:'order', order_id }                                          -> estado de un pedido de RA
// La clave de RA se lee de la variable de entorno RA_API_KEY (nunca va en el código ni en la página).

const lib = require('./_ra-lib');
const RA_BASE = lib.RA_BASE;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ykxyiamlvlppcyfzyvzr.supabase.co';
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || 'sb_publishable_HxcnPrmcb9xu-6QwEJqLvA_vuXbCw5z'; // clave pública (la misma que usa la web)

// v38: solo los productos de lib.FALLBACK se pueden comprar (sin PINES). El costo se toma EN VIVO de Recargas América.
const ALLOWED = lib.FALLBACK;
const NEEDS_ZONE = new Set([249, 250, 251, 252, 253, 254, 255, 256, 257, 258, 259, 260, 261, 262, 263, 264, 265, 266, 267, 268, 269, 270]);
const CATEGORY_OF = (pid) => pid <= 10 ? 'freefire' : pid <= 33 ? 'bloodstrike' : pid <= 39 ? 'pubg' : 'mlbb';

const raKey = lib.raKey;
const RA_SIN_STOCK = false; // v65: true = rechaza todas las compras RA aunque no exista RA_DISABLED
function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (_) { return null; } }
  const chunks = [];
  for await (const c of req) { chunks.push(c); if (chunks.reduce((a, b) => a + b.length, 0) > 20000) return null; }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_) { return null; }
}
async function fetchJson(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 25000);
  try {
    const r = await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch (_) { json = { raw: text.slice(0, 300) }; }
    return { ok: r.ok, status: r.status, json };
  } finally { clearTimeout(t); }
}
function raHeaders(extra) {
  return Object.assign({ 'Authorization': 'Bearer ' + raKey(), 'Content-Type': 'application/json', 'Accept': 'application/json' }, extra || {});
}
async function supaRpc(fn, args) {
  return fetchJson(SUPABASE_URL + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_ANON, 'Authorization': 'Bearer ' + SUPABASE_ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify(args)
  }, 20000);
}
const clean = (s, n) => String(s == null ? '' : s).replace(/[<>]/g, '').trim().slice(0, n);
const errMsg = (j) => clean((j && (j.message || (j.error && j.error.message) || (typeof j.error === 'string' && j.error) || j.raw)) || 'Error', 300);

function checkPlayer(b, pid) {
  const player = String(b.player_id == null ? '' : b.player_id).replace(/\s+/g, '');
  if (!/^\d{4,20}$/.test(player)) return { error: 'ID de jugador inválido (solo números).' };
  let zone = String(b.zone_id == null ? '' : b.zone_id).replace(/\s+/g, '');
  if (NEEDS_ZONE.has(pid)) { if (!/^\d{1,8}$/.test(zone)) return { error: 'Falta la Zona / Servidor (solo números).' }; }
  else zone = '';
  return { player, zone };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { success: false, error: 'Método no permitido' });
  const b = await readBody(req);
  if (!b || typeof b !== 'object') return send(res, 400, { success: false, error: 'JSON inválido' });
  const action = String(b.action || '');

  if (!raKey()) return send(res, 500, { success: false, error: 'Falta configurar RA_API_KEY en Vercel.' });

  if (action === 'order') {
    const oid = String(b.order_id || '');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(oid)) return send(res, 400, { success: false, error: 'order_id inválido' });
    try {
      const r = await fetchJson(RA_BASE + '/catalog/orders/' + encodeURIComponent(oid), { method: 'GET', headers: raHeaders() });
      const d = (r.json && r.json.data) || {};
      return send(res, r.ok ? 200 : 502, { success: r.ok && r.json.success !== false, status: d.status || null, order_id: d.order_id || oid });
    } catch (e) { return send(res, 502, { success: false, error: 'Sin respuesta de Recargas América' }); }
  }

  const pid = Number(b.product_id);
  if (!Object.prototype.hasOwnProperty.call(ALLOWED, pid)) return send(res, 400, { success: false, error: 'Producto no permitido' });
  const pl = checkPlayer(b, pid);
  if (pl.error) return send(res, 400, { success: false, error: pl.error });

  if (action === 'validate') {
    const body = { product_id: pid, service_user_id: pl.player };
    if (pl.zone) body.zone_id = pl.zone;
    try {
      const r = await fetchJson(RA_BASE + '/catalog/validate', { method: 'POST', headers: raHeaders(), body: JSON.stringify(body) }, 15000);
      const d = (r.json && r.json.data) || {};
      // Solo informativo: nunca bloquea una compra
      return send(res, 200, { success: !!r.ok, supported: d.supported !== false, status: d.status || null, account_name: d.account_name ? clean(d.account_name, 80) : null });
    } catch (e) { return send(res, 200, { success: false, supported: false, account_name: null }); }
  }

  if (action !== 'buy') return send(res, 400, { success: false, error: 'Acción inválida' });
  // v65: "Sin stock" temporal de Recargas América. Activalo con RA_DISABLED=1 en Vercel (o poné RA_SIN_STOCK = true acá).
  if (RA_SIN_STOCK || /^(1|true|si|sí)$/i.test(String(process.env.RA_DISABLED || '').trim()))
    return send(res, 503, { success: false, stage: 'checkout', code: 'RA_DISABLED', error: 'Sin stock temporal. No se descontó saldo.' });

  // ---- 1) Cobro + pedido en Supabase (todo o nada, idempotente por request_id) ----
  const token = String(b.token || '');
  const requestId = String(b.request_id || '');
  const order = b.order || {};
  const orderId = String(order.id || '');
  const amount = Math.round(Number(b.amount) * 1e6) / 1e6;
  if (!token || token.length > 200) return send(res, 401, { success: false, stage: 'checkout', error: 'Iniciá sesión para comprar.' });
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(requestId)) return send(res, 400, { success: false, stage: 'checkout', error: 'Solicitud inválida.' });
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(orderId)) return send(res, 400, { success: false, stage: 'checkout', error: 'Pedido inválido.' });
  if (!Number.isFinite(amount) || amount > 10000) return send(res, 400, { success: false, stage: 'checkout', error: 'Monto inválido.' });
  // v38: validar el precio contra el costo ACTUAL de Recargas América (+10%), con 3% de tolerancia
  const live = await lib.getCosts();
  if ((live.inactive || []).includes(pid)) return send(res, 409, { success: false, stage: 'checkout', code: 'PRODUCT_INACTIVE', error: 'Producto agotado / no disponible.' });
  const cost = Number(live.costs[pid]) || ALLOWED[pid];
  const publicPrice = lib.salePrice(cost, pid); // v40: margen propio de cada producto
  const fits = (exp) => !(amount + 1e-9 < cost || amount < exp * (1 - lib.TOLERANCE) - 1e-9 || amount > exp * (1 + lib.TOLERANCE) + 0.01);
  // v60: precio de revendedor. Se verifica el plan EN EL SERVIDOR (kiwi_reseller_status con el token del cliente).
  // Si el plan no está activo o la consulta falla, se usa el precio público.
  let expected = publicPrice, resellerLevel = 0;
  if (b.reseller) {
    try {
      const st = await supaRpc('kiwi_reseller_status', { p_token: token });
      const j = st.ok ? st.json : null;
      const lvl = j && j.ok && j.active ? Number(j.level) || 0 : 0;
      if (lvl >= 1) { resellerLevel = Math.min(2, lvl); expected = lib.resellerSalePrice(cost, pid, resellerLevel); }
    } catch (_) { /* precio público */ }
  }
  if (!fits(expected)) {
    if (resellerLevel && fits(publicPrice)) { expected = publicPrice; resellerLevel = 0; } // pagó el precio público: se acepta
    else return send(res, 409, { success: false, stage: 'checkout', code: 'PRICE_CHANGED', price: expected, reseller_level: resellerLevel, error: 'El precio cambió. Actualizá la página (nuevo precio: ' + expected.toFixed(2) + ' USDT).' });
  }

  const target = 'ID ' + pl.player + (pl.zone ? ' · Zona ' + pl.zone : '');
  const row = {
    id: orderId,
    title: clean(order.title, 200),
    price: clean(order.price, 100),
    method: 'Saldo (entrega automática)',
    status: 'confirmed',
    target_user: target,
    extra: 'AUTO-RA producto #' + pid + (resellerLevel ? ' · Revendedor N' + resellerLevel : '') + ' · ' + target + (order.name ? ' · Nombre: ' + clean(order.name, 60) : '') + ' · Si sigue "en proceso", revisá el pedido kiwii-' + orderId + ' en el panel de Recargas América antes de cargarlo a mano.',
    category: CATEGORY_OF(pid),
    date_str: clean(order.date_str, 60)
  };
  let ck;
  try { ck = await supaRpc('kiwi_checkout', { p_token: token, p_request_id: requestId, p_amount: amount, p_orders: [row] }); }
  catch (e) { return send(res, 502, { success: false, stage: 'checkout', retry: true, error: 'Sin conexión con la base de datos.' }); }
  if (!ck.ok || (ck.json && ck.json.error)) {
    const msg = errMsg(ck.json);
    const missing = /Could not find the function|PGRST202|does not exist/i.test(msg);
    return send(res, 400, { success: false, stage: 'checkout', code: missing ? 'SQL_MISSING' : 'REJECTED', error: missing ? 'Falta aplicar el SQL v35 (kiwi_checkout) en Supabase.' : msg });
  }
  const balance = Number(ck.json && ck.json.balance);

  // ---- 2) Compra en Recargas América (una sola vez por pedido gracias al Idempotency-Key) ----
  const buyBody = { product_id: pid, player_id: pl.player, quantity: 1 };
  if (pl.zone) buyBody.zone_id = pl.zone;
  let ra;
  try {
    ra = await fetchJson(RA_BASE + '/buy/catalog', { method: 'POST', headers: raHeaders({ 'Idempotency-Key': 'kiwii-' + orderId }), body: JSON.stringify(buyBody) }, 30000);
  } catch (e) {
    return send(res, 200, { success: false, charged: true, balance, stage: 'delivery', uncertain: true, error: 'Recargas América no respondió a tiempo.' });
  }
  const d = (ra.json && ra.json.data) || {};
  const ok = ra.ok && ra.json && ra.json.success !== false && !/fail|error|cancel|reject/i.test(String(d.status || ''));
  // 3) Si se entregó, marcar el pedido como entregado (función kiwi_order_provider_status, ya existe desde el SQL v18)
  const delivered = ok && (!d.status || /complet|success|deliver|done|finish/i.test(String(d.status)));
  if (delivered) { try { await supaRpc('kiwi_order_provider_status', { p_token: token, p_id: orderId, p_status: 'delivered' }); } catch (_) {} }
  if (!ok) return send(res, 200, { success: false, charged: true, balance, stage: 'delivery', error: errMsg(ra.json) });
  return send(res, 200, { success: true, charged: true, delivered, balance, ra: { order_id: d.order_id || null, transaction_id: d.transaction_id || null, status: d.status || null } });
};

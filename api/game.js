// v83: entrega automática (Free Fire, Blood Strike, PUBG Mobile, Mobile Legends) con el proveedor configurado por variables de entorno.
// Acciones (POST JSON, salvo webhook/cron):
//   validate  {product_id, player_id, zone_id}            -> nombre de la cuenta si el proveedor lo informa
//   buy       {token, request_id, amount, product_id, player_id, zone_id, order, reseller}
//   status    {token, order_id}                           -> estado de un pedido propio (y lo avanza si toca revisar)
//   staff     {token}                                     -> staff: saldo del proveedor + últimos pedidos automáticos (+ revisa pendientes)
//   resolve   {token, order_id}                           -> staff (Owner/CEO): marcar como resuelto un pedido que quedó manual
//   ?action=webhook  (firma HMAC, CO_WEBHOOK_SECRET)      -> aviso del proveedor: se vuelve a consultar el pedido
//   GET ?action=cron (Authorization: Bearer CRON_SECRET)  -> revisión diaria de pendientes
const lib = require('./_game-lib');
let lowAlertAt = 0;   // aviso de saldo bajo: máximo uno cada 30 min por instancia
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ykxyiamlvlppcyfzyvzr.supabase.co';
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || 'sb_publishable_HxcnPrmcb9xu-6QwEJqLvA_vuXbCw5z'; // clave pública (la misma que usa la web)
const SIN_STOCK = false; // true = rechaza todas las compras automáticas (o variable AUTO_DISABLED=1 / RA_DISABLED=1)

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}
async function readRaw(req) {
  // primero el flujo crudo (la firma del webhook se calcula sobre los bytes exactos); después lo que ya haya parseado Vercel
  const chunks = []; let n = 0;
  if (req.readable !== false && !req.readableEnded && typeof req[Symbol.asyncIterator] === 'function') {
    try { for await (const c of req) { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); n += c.length; if (n > 100000) return null; } } catch (_) {}
  }
  if (chunks.length) return Buffer.concat(chunks).toString('utf8');
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);
  return '';
}
async function readBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  const raw = await readRaw(req); if (raw == null) return null;
  try { return JSON.parse(raw || '{}'); } catch (_) { return null; }
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
async function supaRpc(fn, args) {
  return fetchJson(SUPABASE_URL + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_ANON, 'Authorization': 'Bearer ' + SUPABASE_ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify(args)
  }, 20000);
}
const clean = (s, n) => String(s == null ? '' : s).replace(/[<>]/g, '').trim().slice(0, n);
const errMsg = (j) => clean((j && (j.message || (j.error && j.error.message) || (typeof j.error === 'string' && j.error) || j.raw)) || 'Error', 300);
const disabled = () => SIN_STOCK || /^(1|true|si|sí)$/i.test(String(process.env.AUTO_DISABLED || process.env.RA_DISABLED || '').trim());
// "No Stock" del panel para los diamantes ilimitados: la clave vieja era la del producto del catálogo (p:200…p:205)
const STOCK_ALIAS = { 5: 'p:200', 6: 'p:201', 7: 'p:202', 8: 'p:203', 9: 'p:204', 10: 'p:205' };

function checkPlayer(b, pid) {
  const player = String(b.player_id == null ? '' : b.player_id).replace(/\s+/g, '');
  if (!/^\d{4,20}$/.test(player)) return { error: 'ID de jugador inválido (solo números).' };
  let zone = String(b.zone_id == null ? '' : b.zone_id).replace(/\s+/g, '');
  if (lib.NEEDS_ZONE.has(pid)) { if (!/^\d{1,8}$/.test(zone)) return { error: 'Falta la Zona / Servidor (solo números).' }; }
  else zone = '';
  return { player, zone };
}
async function validatePlayer(ref, payload) {
  const r = await lib.prov('/player/validate', { method: 'POST', body: { product_id: ref, target_payload: payload }, ms: 10000 });
  if (!r.ok || !r.json) return { status: 'unverified', name: null };
  const st = String(r.json.status || 'unverified').toLowerCase();
  return { status: st, name: r.json.player && r.json.player.name ? clean(r.json.player.name, 80) : null };
}
async function itemFor(pid) {
  const live = await lib.getCosts();
  const it = live.items && live.items[pid];
  return { live, it, schema: (live.schemas || {})[pid] };
}
async function isStaff(token) {
  try { const r = await lib.sb('kiwi_prov_staff_list', { p_token: token, p_limit: 40 }); return r; } catch (e) { return null; }
}

async function handler(req, res) {
  const q = req.query || {};
  const qAction = String(q.action || '').toLowerCase();

  // ---- Webhook del proveedor (cuerpo crudo para la firma) ----
  if (qAction === 'webhook') {
    if (req.method !== 'POST') return send(res, 405, { ok: false });
    const raw = await readRaw(req);
    const v = lib.verifyWebhook(req.headers || {}, raw || '', String(process.env.CO_WEBHOOK_SECRET || ''));
    if (!v.ok) return send(res, 401, { ok: false });
    let ev = {}; try { ev = JSON.parse(raw); } catch (_) {}
    const eventId = String(ev.event_id || ev.id || '');
    const fresh = await lib.sbSoft('kiwi_prov_webhook_seen', { p_event_id: eventId });
    if (fresh === false) return send(res, 200, { ok: true, duplicate: true });
    const o = ev.order || ev.data || ev;
    const key = String(o.idempotency_key || ev.idempotency_key || o.reference_code || ev.reference_code || '');
    if (!key) return send(res, 200, { ok: true, ignored: true });
    const rec = await lib.sbSoft('kiwi_prov_order_get', { p_key: key });
    if (rec) { try { await lib.processOrder(rec, true); } catch (_) {} }   // se confirma consultando al proveedor (no se confía solo en el aviso)
    return send(res, 200, { ok: true });
  }
  // ---- Revisión diaria (Vercel Cron) ----
  if (qAction === 'cron') {
    const sec = String(process.env.CRON_SECRET || '');
    if (!sec || String((req.headers || {}).authorization || '') !== 'Bearer ' + sec) return send(res, 401, { ok: false });
    const out = await lib.sweep(20);
    return send(res, 200, { ok: true, checked: out.length });
  }

  if (req.method !== 'POST') return send(res, 405, { success: false, error: 'Método no permitido' });
  const b = await readBody(req);
  if (!b || typeof b !== 'object') return send(res, 400, { success: false, error: 'JSON inválido' });
  const action = String(b.action || '');
  if (!lib.provReady()) return send(res, 500, { success: false, error: 'Servicio temporalmente no disponible.' });

  if (action === 'order') return send(res, 403, { success: false, error: 'Consultá el estado en Mis pedidos.' });

  // ---- Estado de un pedido propio ----
  if (action === 'status') {
    const token = String(b.token || ''), oid = String(b.order_id || '');
    if (!token || token.length > 200 || !/^[A-Za-z0-9_-]{1,64}$/.test(oid)) return send(res, 400, { success: false, error: 'Solicitud inválida.' });
    let rec = null;
    try { rec = await lib.sb('kiwi_prov_order_mine', { p_token: token, p_order_id: oid }); } catch (e) { return send(res, 401, { success: false, error: 'Sesión inválida.' }); }
    if (!rec) return send(res, 404, { success: false, error: 'Pedido no encontrado.' });
    try { rec = await lib.processOrder(rec, false); } catch (_) {}
    try { await lib.sweep(2); } catch (_) {}   // de paso, avanza otros pendientes
    const st = lib.publicStatus(rec);
    const out = { success: true, status: st, next_in_s: st === 'processing' ? lib.nextIn(rec) : null };
    if (st === 'delivered' && Array.isArray(rec.codes) && rec.codes.length) out.codes = rec.codes;
    if (st === 'refunded' && rec._refund && rec._refund.balance != null) out.balance = Number(rec._refund.balance);
    return send(res, 200, out);
  }
  // ---- Staff ----
  if (action === 'staff' || action === 'resolve') {
    const token = String(b.token || '');
    if (!token || token.length > 200) return send(res, 401, { success: false, error: 'Sin permisos.' });
    if (action === 'resolve') {
      try { const r = await lib.sb('kiwi_prov_staff_resolve', { p_token: token, p_order_id: String(b.order_id || '') }); return send(res, 200, { success: true, ok: !!(r && r.ok) }); }
      catch (e) { return send(res, 403, { success: false, error: clean(e.message, 200) }); }
    }
    const first = await isStaff(token);
    if (!first) return send(res, 403, { success: false, error: 'Sin permisos.' });
    let swept = [];
    if (b.sweep !== false) { try { swept = await lib.sweep(8); } catch (_) {} }
    const list = swept.length ? (await isStaff(token)) || first : first;
    const bal = await lib.provBalance(true);
    return send(res, 200, { success: true, balance: bal, orders: list.orders || [], open: list.open || 0, manual: list.manual || 0, checked: swept.length });
  }

  const pid = Number(b.product_id);
  if (!lib.IDS.includes(pid)) return send(res, 400, { success: false, error: 'Producto no permitido' });
  const pl = checkPlayer(b, pid);
  if (pl.error) return send(res, 400, { success: false, error: pl.error });

  if (action === 'validate') {
    try {
      const { it, schema } = await itemFor(pid);
      if (!it) return send(res, 200, { success: false, supported: false, account_name: null });
      const t = lib.buildTarget(it.fields, schema, pl.player, pl.zone);
      if (t.error) return send(res, 200, { success: false, supported: true, status: 'invalid', account_name: null, error: t.error });
      const v = await validatePlayer(it.ref, t.payload);
      return send(res, 200, { success: true, supported: v.status !== 'unverified', status: v.status, account_name: v.name });
    } catch (e) { return send(res, 200, { success: false, supported: false, account_name: null }); }
  }

  if (action !== 'buy') return send(res, 400, { success: false, error: 'Acción inválida' });
  if (disabled()) return send(res, 503, { success: false, stage: 'checkout', code: 'RA_DISABLED', error: 'Sin stock temporal. No se descontó saldo.' });

  try {
    const sf = await supaRpc('kiwi_stock_list', {});
    if (sf.ok && Array.isArray(sf.json) && (sf.json.includes('ra:' + pid) || (STOCK_ALIAS[pid] && sf.json.includes(STOCK_ALIAS[pid]))))
      return send(res, 409, { success: false, stage: 'checkout', code: 'NO_STOCK', error: 'No Stock: este producto no está disponible por el momento. No se descontó saldo.' });
  } catch (_) {}

  const token = String(b.token || '');
  const requestId = String(b.request_id || '');
  const order = b.order || {};
  const orderId = String(order.id || '');
  const amount = Math.round(Number(b.amount) * 1e6) / 1e6;
  if (!token || token.length > 200) return send(res, 401, { success: false, stage: 'checkout', error: 'Iniciá sesión para comprar.' });
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(requestId)) return send(res, 400, { success: false, stage: 'checkout', error: 'Solicitud inválida.' });
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(orderId)) return send(res, 400, { success: false, stage: 'checkout', error: 'Pedido inválido.' });
  if (!Number.isFinite(amount) || amount > 10000) return send(res, 400, { success: false, stage: 'checkout', error: 'Monto inválido.' });
  const { live, it, schema } = await itemFor(pid);
  if (live.source === 'fallback') return send(res, 503, { success: false, stage: 'checkout', code: 'PRICES_UNVERIFIED', error: 'No pudimos confirmar el precio. Probá en unos minutos. No se descontó saldo.' });
  if (!it || (live.inactive || []).includes(pid) || !(Number(live.costs[pid]) > 0)) return send(res, 409, { success: false, stage: 'checkout', code: 'PRODUCT_INACTIVE', error: 'Producto agotado / no disponible.' });
  const cost = Number(live.costs[pid]);
  const publicPrice = lib.salePrice(cost, pid);
  const fits = (exp) => !(amount + 1e-9 < cost || amount < exp * (1 - lib.TOLERANCE) - 1e-9 || amount > exp * (1 + lib.TOLERANCE) + 0.01);
  let expected = publicPrice, resellerLevel = 0;
  if (b.reseller) {
    try {
      const st = await supaRpc('kiwi_reseller_status', { p_token: token });
      const j = st.ok ? st.json : null;
      const lvl = j && j.ok && j.active ? Number(j.level) || 0 : 0;
      if (lvl >= 1) { resellerLevel = Math.min(2, lvl); expected = lib.resellerSalePrice(cost, pid, resellerLevel); }
    } catch (_) {  }
  }
  if (!fits(expected)) {
    if (resellerLevel && fits(publicPrice)) { expected = publicPrice; resellerLevel = 0; }
    else return send(res, 409, { success: false, stage: 'checkout', code: 'PRICE_CHANGED', price: expected, reseller_level: resellerLevel, error: 'El precio cambió. Actualizá la página (nuevo precio: ' + expected.toFixed(2) + ' USDT).' });
  }
  const tgt = lib.buildTarget(it.fields, schema, pl.player, pl.zone);
  if (tgt.error) return send(res, 400, { success: false, stage: 'checkout', error: tgt.error + ' No se descontó saldo.' });

  // Antes de cobrar: saldo del proveedor (si no alcanza, no se vende) y verificación del ID (solo bloquea si es inválido)
  if (!/^(0|off|no|false)$/i.test(String(process.env.PROV_BALANCE_CHECK || ''))) {
    const bal = await lib.provBalance(false);
    if (bal && Number.isFinite(bal.available) && bal.available + 1e-9 < cost) {
      if (Date.now() - lowAlertAt > 30 * 60 * 1000) { lowAlertAt = Date.now(); lib.tg('⚠️ <b>Saldo del proveedor insuficiente</b>: ' + bal.available.toFixed(2) + ' ' + lib.tgEsc(bal.currency) + '. Se rechazó una compra automática de ' + cost.toFixed(2) + '. Recargá saldo en el proveedor. (Aviso cada 30 min como máximo.)').catch(() => {}); }
      return send(res, 503, { success: false, stage: 'checkout', code: 'NO_STOCK', error: 'Sin stock temporal de este producto. No se descontó saldo.' });
    }
  }
  const pv = await validatePlayer(it.ref, tgt.payload).catch(() => ({ status: 'unverified' }));
  if (pv.status === 'invalid') return send(res, 400, { success: false, stage: 'checkout', code: 'INVALID_PLAYER', error: 'Ese ID de jugador no existe' + (lib.NEEDS_ZONE.has(pid) ? ' (o la Zona no corresponde)' : '') + '. Revisalo. No se descontó saldo.' });

  const target = 'ID ' + pl.player + (pl.zone ? ' · Zona ' + pl.zone : '');
  const name = clean(order.name, 60) || (pv.name || '');
  const row = {
    id: orderId,
    title: clean(order.title, 200),
    price: clean(order.price, 100),
    method: 'Saldo (entrega automática)',
    status: 'confirmed',
    target_user: target,
    extra: 'Entrega automática · ' + target + (name ? ' · Nombre: ' + name : ''),
    category: lib.CATEGORY_OF(pid),
    date_str: clean(order.date_str, 60)
  };
  let ck;
  try { ck = await supaRpc('kiwi_checkout', { p_token: token, p_request_id: requestId, p_amount: amount, p_orders: [row] }); }
  catch (e) { return send(res, 502, { success: false, stage: 'checkout', retry: true, error: 'Sin conexión con la base de datos.' }); }
  if (!ck.ok || (ck.json && ck.json.error)) {
    const msg = errMsg(ck.json);
    const missing = /Could not find the function|PGRST202|does not exist/i.test(msg);
    return send(res, 400, { success: false, stage: 'checkout', code: missing ? 'SQL_MISSING' : 'REJECTED', error: missing ? 'Servicio temporalmente no disponible. No se descontó saldo.' : (/saldo insuficiente/i.test(msg) ? 'Saldo insuficiente.' : 'No pudimos confirmar la compra. Consultá a soporte antes de reintentar.') });
  }
  let balance = Number(ck.json && ck.json.balance);

  // Cobrado: registrar y enviar al proveedor (la misma Idempotency-Key en cualquier reintento → nunca dos recargas)
  let rec;
  try { rec = await lib.sb('kiwi_prov_order_create', { p_order_id: orderId, p_kiwi_key: pid, p_product_ref: it.ref, p_target: tgt.payload, p_cost: cost, p_pin: !!it.pin }); }
  catch (e) {
    lib.tg('⚠️ <b>Entrega automática sin registrar</b> (falta kiwii-v83.sql?)\nPedido #' + lib.tgEsc(orderId) + ' · ' + lib.tgEsc(row.title) + '\n' + lib.tgEsc(e.message)).catch(() => {});
    return send(res, 200, { success: false, charged: true, balance, stage: 'delivery', error: 'La entrega sigue pendiente. La revisamos y la cargamos a mano.' });
  }
  try { rec = await lib.processOrder(rec, true); } catch (e) { rec = Object.assign({}, rec, { status: 'retry' }); }
  const st = lib.publicStatus(rec);
  if (st === 'delivered') return send(res, 200, { success: true, charged: true, delivered: true, balance, codes: Array.isArray(rec.codes) && rec.codes.length ? rec.codes : undefined });
  if (st === 'refunded') {
    if (rec._refund && rec._refund.balance != null) balance = Number(rec._refund.balance);
    return send(res, 200, { success: false, charged: true, refunded: true, balance, stage: 'delivery', error: 'El proveedor rechazó la recarga. Se devolvió el saldo.' });
  }
  if (st === 'manual') return send(res, 200, { success: false, charged: true, balance, stage: 'delivery', error: 'La entrega automática no está disponible en este momento' });
  return send(res, 200, { success: true, charged: true, delivered: false, pending: true, balance, order_id: orderId, next_in_s: 30 });
}
module.exports = handler;

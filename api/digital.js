

const BASE = 'https://resellme.xyz/api/reseller/v1';

function getKey() {
  const key = process.env.RESELLME_API_KEY;
  if (!key) throw new Error('Servicio temporalmente no disponible.');
  return key;
}

async function api(path, options = {}) {
  const res = await fetch(BASE + path, {
    ...options,
    headers: {
      Authorization: 'Bearer ' + getKey(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { ok: res.ok && !data?.error && !data?.raw && data?.success !== false, status: res.status, data };
}

// v94: referencia firmada del pedido (la guarda la web en el pedido; el servidor solo consulta referencias que firmó él)
const crypto = require('crypto');
function refKey() { const s = String(process.env.KIWI_REF_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim(); return s.length >= 16 ? crypto.createHash('sha256').update('kiwi-ref|' + s).digest() : null; }
function signRef(id) {
  const k = refKey(), v = String(id == null ? '' : id);
  if (!k || !/^[A-Za-z0-9_-]{1,44}$/.test(v)) return null;
  return 'D:' + v + '.' + crypto.createHmac('sha256', k).update(v).digest('hex').slice(0, 16);
}
function verifyRef(ref) {
  const m = /^D:([A-Za-z0-9_-]{1,44})\.([0-9a-f]{16})$/.exec(String(ref || '')); if (!m) return null;
  const good = signRef(m[1]); if (!good) return null;
  const a = Buffer.from(good), b = Buffer.from(String(ref));
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? m[1] : null;
}


// ---------- v95: precio de venta calculado en el servidor (regla de siempre: % sobre el costo + 2 cuentas si es barato) ----------
//  costo < 0,75          → se entregan 2 cuentas, precio = el de 1 cuenta
//  0,75 <= costo < 1     → se entregan 2 cuentas a digital_x2 (2,5 USDT)
//  costo >= 1            → 1 cuenta
//  precio = costo(EUR) × EUR→USD × (1 + %/100), redondeado hacia arriba (USDT entero) y nunca menos que digital_min
// v98: los códigos de producto del servicio YA NO están en el código (el repo es público).
//  Viven en la tabla privada kiwi_supplier_map (solo service_role, kiwii-v98.sql). La web usa claves propias de Kiwii
//  (ej. 'netflix.espana-lifetime'); el servidor las traduce. Sin la tabla, streaming queda "no disponible" (nunca vende a ciegas).
let mapMem = { at: 0, v: null };
async function supplierMap(force) {
  if (!force && mapMem.v && Date.now() - mapMem.at < 5 * 60 * 1000) return mapMem.v;
  let rows = null;
  try { rows = await require('./_game-lib').sb('kiwi_supplier_map_get', {}, 6000); } catch (_) { rows = null; }
  if (!Array.isArray(rows)) return mapMem.v;   // si falla, se usa el último bueno (o null = no disponible)
  const byKey = {}, bySid = {}, blocked = new Set(), social = {};
  for (const r of rows) {
    if (!r || !r.key) continue;
    if (r.kind === 'social') { if (r.active && r.service_id) social[r.key] = { service: String(r.service_id), title: r.title, category: r.category }; continue; }
    if (!r.product_id) continue;
    if (!r.active) { blocked.add(String(r.variant_id || r.product_id)); if (!r.variant_id) blocked.add(String(r.product_id)); continue; }
    const e = { key: r.key, product_id: String(r.product_id), variant_id: r.variant_id ? String(r.variant_id) : null, title: r.title || r.key, category: r.category || 'streaming',
      qtys: Array.isArray(r.qtys) && r.qtys.length ? r.qtys.map(Number).filter(n => Number.isInteger(n) && n > 0) : null, pct: r.unit_pct != null ? Number(r.unit_pct) : null, single: !!r.single };
    byKey[e.key] = e; bySid[e.variant_id || e.product_id] = e;
  }
  mapMem = { at: Date.now(), v: { byKey, bySid, blocked, social } };
  return mapMem.v;
}
const ceil2 = x => Math.ceil(Math.round(x * 100 * 1e6) / 1e6 - 1e-9) / 100;
const DEF = { digital_pct: 30, eur_usd: 1.15, digital_min: 2, digital_x2: 2.5, digital_step: 1 };
let rulesMem = { at: 0, v: null };
async function rules() {
  if (rulesMem.v && Date.now() - rulesMem.at < 5 * 60 * 1000) return rulesMem.v;
  let r = null;
  try { const lib = require('./_game-lib'); r = await lib.sbSoft('kiwi_cost_server_rules', {}, 4000); } catch (_) { r = null; }
  const s = Object.assign({}, DEF), st = (r && r.settings) || {};
  for (const k of Object.keys(DEF)) { const n = Number(st[k]); if (Number.isFinite(n) && n >= 0) s[k] = n; }
  const v = { s, over: (r && r.digital && typeof r.digital === 'object') ? r.digital : {} };
  if (r) rulesMem = { at: Date.now(), v };
  return v;
}
function priceOf(id, cost, R, e) {   // id = código del servicio (para el % propio guardado en COSTOS) · e = entrada del mapa privado
  const c = Number(cost); if (!(c > 0)) return null;
  const s = (R && R.s) || DEF, o = R && R.over && R.over[id];
  if (e && e.qtys) {   // v96: por cuenta, x2 del costo (100%) salvo que el Owner ponga otro %
    const pct = Number.isFinite(Number(o)) && o !== null ? Number(o) : (e.pct != null ? e.pct : 100);
    return { qty: 1, price: ceil2(c * (1 + pct / 100)), pct, per_unit: true, qtys: e.qtys.slice() };
  }
  const pct = Number.isFinite(Number(o)) && o !== null ? Number(o) : s.digital_pct;
  const step = s.digital_step > 0 ? s.digital_step : 1;
  const up = x => Math.ceil(Math.round(x / step * 1e6) / 1e6 - 1e-9) * step;
  const one = Math.max(s.digital_min, Math.round(up(c * s.eur_usd * (1 + pct / 100)) * 100) / 100);
  if ((e && e.single) || c >= 1) return { qty: 1, price: one, pct };
  if (c < 0.75) return { qty: 2, price: one, pct };
  return { qty: 2, price: Math.max(s.digital_x2, o != null ? one : 0), pct };
}
// costo y stock en vivo de una entrada del mapa
function liveOf(products, e) {
  const p = (Array.isArray(products) ? products : []).find(x => x && String(x.id) === e.product_id);
  if (!p) return null;
  if (e.variant_id) { const v = (p.variants || []).find(x => x && String(x.id) === e.variant_id); return v ? { cost: v.price, stock: v.stock } : null; }
  if ((p.variants || []).length) return null;
  return { cost: p.price, stock: p.stock };
}

// Keys / datos de acceso que vienen en la respuesta de un pedido
function keysOf(data) {
  const keys = [];
  if (!data || typeof data !== 'object') return keys;
  if (Array.isArray(data.items)) {
    for (const it of data.items) {
      if (!it) continue;
      if (Array.isArray(it.keys)) keys.push(...it.keys);
      else if (it.keys) keys.push(String(it.keys));
      if (it.account) keys.push(String(it.account));
    }
  }
  if (Array.isArray(data.keys)) keys.push(...data.keys);
  if (data.account) keys.push(String(data.account));
  return keys;
}

// ---------- v98: TODA compra de streaming / IA / herramientas pasa por acá (antes solo Steam). ----------
//  1) sesión (token) · 2) clave de Kiwii → producto del servicio (mapa privado) · 3) costo y stock en vivo → precio calculado acá
//  4) cobro + pedido en un solo paso (kiwi_checkout; sin saldo no se cobra nada; mismo request_id = no se cobra dos veces)
//  5) pedido al servicio (Idempotency-Key) · 6) resultado: entregado / incompleto / en proceso / con problema / rechazado → saldo devuelto.
const sbLib = () => require('./_game-lib');
const keyText = (keys) => keys.map((k, i) => 'Cuenta ' + (i + 1) + ':\n' + k).join('\n\n');
const clean = (v, n) => String(v == null ? '' : v).replace(/[<>\u0000-\u001f]/g, ' ').trim().slice(0, n);
async function buy(b, res) {
  const token = String(b.token || ''), requestId = String(b.request_id || '');
  const amount = Number(b.amount);
  if (!token || token.length > 400) return res.status(401).json({ success: false, error: 'Iniciá sesión para comprar.' });
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(requestId)) return res.status(400).json({ success: false, error: 'Solicitud inválida.' });
  const M = await supplierMap();
  if (!M) return res.status(503).json({ success: false, error: 'Servicio temporalmente no disponible. No se descontó saldo.' });
  const e = M.byKey[String(b.key || '')];
  if (!e) return res.status(400).json({ success: false, error: 'Producto no disponible. Actualizá la página.' });
  // costo y stock en vivo
  const live = await api('/products');
  if (!live.ok) return res.status(502).json({ success: false, error: 'Catálogo temporalmente no disponible. No se descontó saldo.' });
  const L = liveOf(live.data.products, e);
  if (!L) return res.status(409).json({ success: false, code: 'NO_STOCK', error: 'Producto sin stock. No se descontó saldo.' });
  const t = priceOf(e.variant_id || e.product_id, L.cost, await rules(), e);
  if (!t) return res.status(409).json({ success: false, code: 'NO_STOCK', error: 'Producto no disponible. No se descontó saldo.' });
  let qty, total;
  if (t.per_unit) {
    qty = Number(b.quantity);
    if (!t.qtys.includes(qty)) return res.status(400).json({ success: false, code: 'BAD_QTY', error: 'Cantidad no permitida. Opciones: ' + t.qtys.join(', ') + ' cuentas.' });
    total = Math.round(t.price * qty * 100) / 100;
  } else { qty = t.qty; total = t.price; }
  if (L.stock !== null && L.stock !== undefined && Number(L.stock) < qty) return res.status(409).json({ success: false, code: 'NO_STOCK', stock: Number(L.stock), error: (Number(L.stock) > 0 ? 'No hay stock suficiente (quedan ' + Number(L.stock) + ').' : 'Producto sin stock.') + ' No se descontó saldo.' });
  if (!(Math.abs(amount - total) <= 0.005)) return res.status(409).json({ success: false, code: 'PRICE_CHANGED', unit: t.price, price: total, qty,
    error: t.per_unit ? 'El precio cambió: ' + qty + ' cuentas = ' + total.toFixed(2) + ' USDT (' + t.price.toFixed(2) + ' c/u). Volvé a elegir la cantidad.' : 'El precio cambió: ahora ' + total.toFixed(2) + ' USDT' + (qty === 2 ? ' (x2 cuentas)' : '') + '. Volvé a elegir el producto.' });
  // cobro + pedido (atómico). El id del pedido lo genera el servidor.
  const orderId = String(Date.now() * 1000 + Math.floor(Math.random() * 1000));
  const title = t.per_unit ? e.title + ' x' + qty : (clean(b.title, 150) || e.title) + (qty === 2 ? ' (x2 cuentas)' : '');
  const row = { id: orderId, title, price: clean(b.price, 100) || total.toFixed(2) + ' USDT', usdt: total, method: 'Saldo Página', status: 'confirmed', target_user: 'N/A',
    extra: 'Entrega automática' + (qty > 1 ? ' · ' + qty + ' cuentas' : ''), category: e.category, date_str: clean(b.date_str, 60) };
  const lib = sbLib();
  let ck;
  try { ck = await lib.sb('kiwi_checkout', { p_token: token, p_request_id: requestId, p_amount: total, p_orders: [row] }, 15000); }
  catch (err) {
    const m = String(err.message || '');
    return res.status(/insuficiente/i.test(m) ? 402 : /sesi/i.test(m) ? 401 : 400).json({ success: false, error: /insuficiente/i.test(m) ? 'Saldo insuficiente.' : /sesi/i.test(m) ? 'Sesión inválida. Volvé a iniciar sesión.' : 'No se pudo cobrar. No se descontó saldo.' });
  }
  if (ck && ck.duplicate) return res.status(409).json({ success: false, code: 'DUPLICATE', balance: Number(ck.balance), error: 'Esta compra ya se procesó. Revisá Mis pedidos.' });
  let balance = Number(ck && ck.balance);
  const finish = async (result, extra) => { try { const r = await lib.sb('kiwi_digital_finish', Object.assign({ p_order_id: orderId, p_result: result }, extra || {})); if (r && r.balance != null) balance = Number(r.balance); return r; } catch (_) { return null; } };
  // pedido al servicio (una línea; la misma clave de idempotencia si se reintenta)
  const item = { product_id: e.product_id, quantity: qty }; if (e.variant_id) item.variant_id = e.variant_id;
  let r;
  try { r = await api('/orders', { method: 'POST', headers: { 'Idempotency-Key': 'kiwi-' + orderId }, body: JSON.stringify({ items: [item] }) }); }
  catch (_) { r = { ok: false, status: 0, data: null }; }
  const base = { order_id: orderId, title, quantity: qty, unit: t.price, price: total, charged: true };
  if (!r.ok) {
    if ([400, 402, 404, 409, 422].includes(r.status)) {   // rechazado: no se entregó nada → devolver
      await finish('refund');
      return res.status(200).json(Object.assign(base, { success: false, refunded: true, balance, error: 'El servicio no pudo entregar el pedido. Se devolvió el saldo.' }));
    }
    await finish('problem', { p_note: 'No pudimos confirmar la entrega con el servicio. El staff revisa este pedido y te entrega los datos o te devuelve el saldo.' });
    lib.tg('⚠️ <b>Streaming sin confirmar</b>\nPedido #' + orderId + ' · ' + lib.tgEsc(title) + ' · HTTP ' + r.status + '. Revisar en el servicio antes de devolver.').catch(() => {});
    return res.status(200).json(Object.assign(base, { success: false, problem: true, balance, error: 'No pudimos confirmar la entrega. El staff lo revisa (no compres de nuevo).' }));
  }
  const keys = keysOf(r.data).map(k => typeof k === 'string' ? k : JSON.stringify(k));
  const remote = r.data.order_id || r.data.id || null;
  const text = qty > 1 ? keyText(keys) : keys.join('\n');
  if (keys.length >= qty) {
    await finish('delivered', { p_extra: text });
    return res.status(200).json(Object.assign(base, { success: true, delivered: true, status: 'delivered', keys, balance }));
  }
  if (keys.length > 0) {
    await finish('partial', { p_extra: text, p_note: 'Llegaron ' + keys.length + ' de ' + qty + ' cuentas. El staff te entrega las que faltan o te devuelve esa parte.' });
    lib.tg('⚠️ <b>Streaming incompleto</b>: llegaron ' + keys.length + ' de ' + qty + '. Pedido #' + orderId + ' · ' + lib.tgEsc(title)).catch(() => {});
    return res.status(200).json(Object.assign(base, { success: true, delivered: false, partial: true, status: 'problem', keys, balance }));
  }
  const ref = remote ? signRef(remote) : null;
  if (ref) { await finish('pending', { p_ref: ref }); return res.status(200).json(Object.assign(base, { success: true, delivered: false, pending: true, status: 'processing', keys: [], balance })); }
  await finish('problem', { p_note: 'El servicio no devolvió los datos de acceso. El staff revisa este pedido.' });
  return res.status(200).json(Object.assign(base, { success: false, problem: true, balance, error: 'El servicio no devolvió los datos. El staff lo revisa.' }));
}

function adminOk(req) {   // mismo secreto de admin que /api/social (header x-pay-secret = PAY_NOTIF_SECRET)
  const secret = String(process.env.PAY_NOTIF_SECRET || '');
  const given = String((req.headers && (req.headers['x-pay-secret'] || req.headers['x-admin-secret'])) || '');
  const a = Buffer.from(given), b = Buffer.from(secret);
  return secret.length >= 16 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'JSON inválido' }); } }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Body requerido' });

  const action = String(body.action || '').toLowerCase();

  try {
    // v98: la acción vieja (pedido al servicio SIN sesión y SIN cobro) quedó cerrada.
    if (action === 'order' || action === 'add') {
      return res.status(410).json({ success: false, code: 'UPDATE_PAGE', error: 'Actualizá la página (Ctrl+F5) para comprar. No se descontó saldo.' });
    }
    if (action === 'buy' || action === 'buy_qty') return await buy(body, res);

    if (action === 'products') {
      // v95/v98: público = SOLO clave de Kiwii, precio de venta (USDT), stock y cantidad de cuentas. Nunca costos ni códigos del servicio.
      const M = await supplierMap();
      if (!M) return res.status(503).json({ success: false, error: 'Catálogo temporalmente no disponible.' });
      const { ok, data } = await api('/products');
      if (!ok) return res.status(502).json({ success: false, error: 'Catálogo temporalmente no disponible.' });
      const R = await rules(), items = {};
      for (const e of Object.values(M.byKey)) {
        const L = liveOf(data.products, e); if (!L) continue;
        const t = priceOf(e.variant_id || e.product_id, L.cost, R, e);
        const o = { stock: L.stock === undefined ? null : L.stock, qty: t ? t.qty : 1, price: t ? t.price : null };
        if (t && t.per_unit) { o.per_unit = true; o.qtys = t.qtys; }
        items[e.key] = o;
      }
      return res.status(200).json({ success: true, items });
    }

    // Saldo en el servicio: solo admin (antes respondía a cualquiera)
    if (action === 'balance') {
      if (!adminOk(req)) return res.status(401).json({ success: false, error: 'no autorizado' });
      const { ok, data } = await api('/balance');
      if (!ok) return res.status(502).json({ success: false, error: 'Consulta temporalmente no disponible.' });
      return res.status(200).json({ balance: data.balance, currency: data.currency });
    }

    // v98: 'order_status' / 'status' quitados (consultaban cualquier pedido del servicio sin sesión). El estado lo revisa el servidor (/api/game autosync).
    return res.status(400).json({ error: 'action inválida.' });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Servicio temporalmente no disponible.' });
  }
};

// v94: consulta de estado para la sincronización automática del servidor (api/_auto-sync.js). No expone nada al público.
module.exports.verifyRef = verifyRef;
module.exports.signRef = signRef;
module.exports.statusOf = async function statusOf(orderId) {
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 12000);
    let r; try { r = await api('/orders/' + encodeURIComponent(orderId), { signal: ctrl.signal }); } finally { clearTimeout(t); }
    const o = r.data && typeof r.data.order === 'object' ? r.data.order : r.data;
    if (!r.ok || !o) return { ok: false, http: r.status, notFound: r.status === 404 };
    const keys = keysOf(o).map(k => typeof k === 'string' ? k : JSON.stringify(k));
    return { ok: true, status: String(o.status || ''), keys };
  } catch (e) { return { ok: false, http: 0, error: 'red' }; }
};

// v95/v98: catálogo completo con nombres y costos SOLO para el panel del Owner (lo llama /api/game action=owner_costs, que ya verificó el rango).
//  'kk' = clave de Kiwii si ya está publicado en la tienda · store.gone / store.out = claves publicadas que ya no existen / sin stock.
module.exports.ownerCatalog = async function ownerCatalog() {
  const [{ ok, data }, M] = await Promise.all([api('/products'), supplierMap(true)]);
  if (!ok) return { ok: false };
  const R = await rules(), map = M || { bySid: {}, byKey: {}, blocked: new Set() };
  const prods = (Array.isArray(data.products) ? data.products : []).filter(p => !map.blocked.has(String(p.id)));
  const gone = [], out = [];
  for (const e of Object.values(map.byKey)) { const L = liveOf(prods, e); if (!L) gone.push(e.key); else if (L.stock !== null && L.stock !== undefined && Number(L.stock) <= 0) out.push(e.key); }
  const one = (id, name, cost, stock) => { const e = map.bySid[String(id)]; return { id, name: String(name || '').slice(0, 120), cost, stock, kk: e ? e.key : null, sale: priceOf(id, cost, R, e) }; };
  return { ok: true, mapped: !!M, currency: /^(EUR|USD|USDT)$/.test(data.currency) ? data.currency : 'EUR', settings: R.s, store: { gone, out },
    products: prods.map(p => { const vs = (Array.isArray(p.variants) ? p.variants : []).filter(v => !map.blocked.has(String(v.id)));
      const o = one(p.id, p.name, p.price, p.stock); if (vs.length) o.sale = null;
      o.variants = vs.map(v => one(v.id, v.name, v.price, v.stock)); return o; }) };
};
module.exports.priceOf = priceOf;
module.exports.supplierMap = supplierMap;
module.exports.liveOf = liveOf;
module.exports._resetRules = () => { rulesMem = { at: 0, v: null }; mapMem = { at: 0, v: null }; };

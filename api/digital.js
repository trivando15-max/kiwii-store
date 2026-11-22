

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
const X2_EXCLUDED = ['cmsro5py90002zknc3e4v4e9a'];   // ChatGPT 1 día: siempre 1 cuenta
// v96: productos que se venden POR CANTIDAD (precio por cuenta = costo × (1 + %), sin mínimo de 2 USDT ni regla x2).
//  Se compran con la acción 'buy_qty' (cobro + pedido en el servidor). La acción vieja 'order' no los acepta.
const QTY_ITEMS = {
  'cmq8m0zpp0001se7mx6lgvo4r': { product_id: 'cmq8g2ydv003v14654mm8qldx', pct: 100, qtys: [20, 30, 40, 50, 100], title: 'Steam - Cuenta con juegos', category: 'tools' }
};
// v96: productos quitados del catálogo (no se venden aunque el servicio los tenga)
const BLOCKED = ['cmryy8d2v000dgjim9gsina83'];   // FiveM
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
function priceOf(id, cost, R) {
  const c = Number(cost); if (!(c > 0)) return null;
  const s = (R && R.s) || DEF, o = R && R.over && R.over[id];
  if (QTY_ITEMS[id]) {   // v96: por cuenta, x2 del costo (100%) salvo que el Owner ponga otro %
    const q = QTY_ITEMS[id], pct = Number.isFinite(Number(o)) && o !== null ? Number(o) : q.pct;
    return { qty: 1, price: ceil2(c * (1 + pct / 100)), pct, per_unit: true, qtys: q.qtys.slice() };
  }
  const pct = Number.isFinite(Number(o)) && o !== null ? Number(o) : s.digital_pct;
  const step = s.digital_step > 0 ? s.digital_step : 1;
  const up = x => Math.ceil(Math.round(x / step * 1e6) / 1e6 - 1e-9) * step;
  const one = Math.max(s.digital_min, Math.round(up(c * s.eur_usd * (1 + pct / 100)) * 100) / 100);
  if (X2_EXCLUDED.includes(String(id)) || c >= 1) return { qty: 1, price: one, pct };
  if (c < 0.75) return { qty: 2, price: one, pct };
  return { qty: 2, price: Math.max(s.digital_x2, o != null ? one : 0), pct };
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

// ---------- v96: compra POR CANTIDAD (Steam): el servidor valida cantidad y precio, cobra el saldo, pide al servicio y entrega ----------
//  1) cantidad permitida (20/30/40/50/100) · 2) costo y stock en vivo → precio = cantidad × precio por cuenta (calculado acá)
//  3) cobro + pedido en un solo paso (kiwi_checkout; si el saldo no alcanza no se cobra nada) · 4) pedido al servicio con esa cantidad
//  5) entrega: todas las cuentas → "Completado"; algunas → "Con problema" (el staff completa o devuelve); ninguna todavía → "En proceso"
//     (la revisión automática lo completa); el servicio lo rechazó → se devuelve el saldo solo.
const sbLib = () => require('./_game-lib');
const keyText = (keys) => keys.map((k, i) => 'Cuenta ' + (i + 1) + ':\n' + k).join('\n\n');
async function buyQty(b, res) {
  const token = String(b.token || ''), requestId = String(b.request_id || '');
  const vid = String(b.variant_id || ''), q = QTY_ITEMS[vid], qty = Number(b.quantity), amount = Number(b.amount);
  if (!token || token.length > 400) return res.status(401).json({ success: false, error: 'Iniciá sesión para comprar.' });
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(requestId)) return res.status(400).json({ success: false, error: 'Solicitud inválida.' });
  if (!q) return res.status(400).json({ success: false, error: 'Producto no disponible.' });
  if (!q.qtys.includes(qty)) return res.status(400).json({ success: false, code: 'BAD_QTY', error: 'Cantidad no permitida. Opciones: ' + q.qtys.join(', ') + ' cuentas.' });
  // costo y stock en vivo
  const live = await api('/products');
  if (!live.ok) return res.status(502).json({ success: false, error: 'Catálogo temporalmente no disponible. No se descontó saldo.' });
  const prod = (Array.isArray(live.data.products) ? live.data.products : []).find(p => p.id === q.product_id);
  const v = prod && (prod.variants || []).find(x => x.id === vid);
  if (!v) return res.status(409).json({ success: false, code: 'NO_STOCK', error: 'Producto sin stock. No se descontó saldo.' });
  if (v.stock !== null && v.stock !== undefined && Number(v.stock) < qty) return res.status(409).json({ success: false, code: 'NO_STOCK', stock: Number(v.stock), error: 'No hay stock para ' + qty + ' cuentas (quedan ' + Number(v.stock) + '). No se descontó saldo.' });
  const t = priceOf(vid, v.price, await rules());
  if (!t) return res.status(409).json({ success: false, code: 'NO_STOCK', error: 'Producto no disponible. No se descontó saldo.' });
  const total = Math.round(t.price * qty * 100) / 100;
  if (!(Math.abs(amount - total) <= 0.005)) return res.status(409).json({ success: false, code: 'PRICE_CHANGED', unit: t.price, price: total, error: 'El precio cambió: ' + qty + ' cuentas = ' + total.toFixed(2) + ' USDT (' + t.price.toFixed(2) + ' c/u). Volvé a elegir la cantidad.' });
  // cobro + pedido (atómico). El id del pedido lo genera el servidor.
  const orderId = String(Date.now() * 1000 + Math.floor(Math.random() * 1000));
  const title = q.title + ' x' + qty;
  const row = { id: orderId, title, price: total.toFixed(2) + ' USDT', usdt: total, method: 'Saldo Página', status: 'confirmed', target_user: 'N/A',
    extra: 'Entrega automática · ' + qty + ' cuentas', category: q.category, date_str: String(b.date_str || '').replace(/[<>]/g, '').slice(0, 60) };
  const lib = sbLib();
  let ck;
  try { ck = await lib.sb('kiwi_checkout', { p_token: token, p_request_id: requestId, p_amount: total, p_orders: [row] }, 15000); }
  catch (e) {
    const m = String(e.message || '');
    return res.status(/insuficiente/i.test(m) ? 402 : /sesi/i.test(m) ? 401 : 400).json({ success: false, error: /insuficiente/i.test(m) ? 'Saldo insuficiente.' : /sesi/i.test(m) ? 'Sesión inválida. Volvé a iniciar sesión.' : 'No se pudo cobrar. No se descontó saldo.' });
  }
  if (ck && ck.duplicate) return res.status(409).json({ success: false, code: 'DUPLICATE', balance: Number(ck.balance), error: 'Esta compra ya se procesó. Revisá Mis pedidos.' });
  let balance = Number(ck && ck.balance);
  const finish = async (result, extra) => { try { const r = await lib.sb('kiwi_digital_finish', Object.assign({ p_order_id: orderId, p_result: result }, extra || {})); if (r && r.balance != null) balance = Number(r.balance); return r; } catch (e) { return null; } };
  // pedido al servicio con la cantidad elegida (una sola línea; la misma clave de idempotencia si se reintenta)
  let r;
  try { r = await api('/orders', { method: 'POST', headers: { 'Idempotency-Key': 'kiwi-' + orderId }, body: JSON.stringify({ items: [{ product_id: q.product_id, variant_id: vid, quantity: qty }] }) }); }
  catch (e) { r = { ok: false, status: 0, data: null }; }
  const base = { order_id: orderId, title, quantity: qty, unit: t.price, price: total, charged: true };
  if (!r.ok) {
    if ([400, 402, 404, 409, 422].includes(r.status)) {   // rechazado: no se entregó nada → devolver
      await finish('refund');
      return res.status(200).json(Object.assign(base, { success: false, refunded: true, balance, error: 'El servicio no pudo entregar el pedido. Se devolvió el saldo.' }));
    }
    await finish('problem', { p_note: 'No pudimos confirmar la entrega con el servicio. El staff revisa este pedido y te entrega las cuentas o te devuelve el saldo.' });
    lib.tg('⚠️ <b>Steam x' + qty + ' sin confirmar</b>\nPedido #' + orderId + ' · HTTP ' + r.status + '. Revisar en el servicio antes de devolver.').catch(() => {});
    return res.status(200).json(Object.assign(base, { success: false, problem: true, balance, error: 'No pudimos confirmar la entrega. El staff lo revisa (no compres de nuevo).' }));
  }
  const keys = keysOf(r.data).map(k => typeof k === 'string' ? k : JSON.stringify(k));
  const remote = r.data.order_id || r.data.id || null;
  if (keys.length >= qty) {
    await finish('delivered', { p_extra: keyText(keys) });
    return res.status(200).json(Object.assign(base, { success: true, delivered: true, status: 'delivered', keys, balance }));
  }
  if (keys.length > 0) {
    await finish('partial', { p_extra: keyText(keys), p_note: 'Llegaron ' + keys.length + ' de ' + qty + ' cuentas. El staff te entrega las que faltan o te devuelve esa parte.' });
    lib.tg('⚠️ <b>Steam x' + qty + ' incompleto</b>: llegaron ' + keys.length + '. Pedido #' + orderId).catch(() => {});
    return res.status(200).json(Object.assign(base, { success: true, delivered: false, partial: true, status: 'problem', keys, balance }));
  }
  const ref = remote ? signRef(remote) : null;
  if (ref) { await finish('pending', { p_ref: ref }); return res.status(200).json(Object.assign(base, { success: true, delivered: false, pending: true, status: 'processing', keys: [], balance })); }
  await finish('problem', { p_note: 'El servicio no devolvió los datos de acceso. El staff revisa este pedido.' });
  return res.status(200).json(Object.assign(base, { success: false, problem: true, balance, error: 'El servicio no devolvió los datos. El staff lo revisa.' }));
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: 'JSON inválido' });
    }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Body requerido' });
  }

  const action = String(body.action || '').toLowerCase();

  try {
    if (action === 'order' || action === 'add') {
      const product_id = body.product_id || body.productId;
      const variant_id = body.variant_id || body.variantId || undefined;
      const quantity = Number(body.quantity || 1);

      if (!product_id) {
        return res.status(400).json({ success: false, error: 'product_id es obligatorio' });
      }
      if (!quantity || quantity < 1) {
        return res.status(400).json({ success: false, error: 'quantity inválida' });
      }

      // v96: Steam (por cantidad) solo con 'buy_qty'; FiveM quitado; el resto: 1 o 2 cuentas (regla x2)
      if (BLOCKED.includes(String(product_id)) || QTY_ITEMS[String(variant_id || '')] || Object.values(QTY_ITEMS).some(q => q.product_id === String(product_id))) {
        return res.status(400).json({ success: false, error: 'Este producto no está disponible por esta vía. Actualizá la página.' });
      }
      if (!Number.isInteger(quantity) || quantity > 2) {
        return res.status(400).json({ success: false, error: 'quantity inválida' });
      }
      const item = { product_id: String(product_id), quantity };
      if (variant_id) item.variant_id = String(variant_id);

      const { ok, status, data } = await api('/orders', {
        method: 'POST',
        body: JSON.stringify({ items: [item] })
      });

      if (!ok) {
        return res.status(status === 402 || status === 409 ? 200 : 502).json({success:false, error:status === 409 ? 'Sin stock disponible.' : 'No pudimos completar la entrega. Consultá a soporte.'});
      }

      const keys = keysOf(data);

      return res.status(200).json({
        success: true,
        order_id: data.order_id || data.id || null,
        status: data.status || 'completed',
        keys,
        ref: signRef(data.order_id || data.id) || undefined,

      });
    }

    if (action === 'buy_qty') return await buyQty(body, res);

    if (action === 'products') {
      const { ok, data } = await api('/products');
      if (!ok) {
        return res.status(502).json({ success: false, error: 'Catálogo temporalmente no disponible.' });
      }
      // v95: público = SOLO precio de venta (USDT), stock y cantidad de cuentas por compra. Nunca el costo.
      const R = await rules();
      const sale = (id, cost, stock) => { const t = priceOf(id, cost, R); const o = { id, stock, qty: t ? t.qty : 1, price: t ? t.price : null }; if (t && t.per_unit) { o.per_unit = true; o.qtys = t.qtys; } return o; };
      return res.status(200).json({ success: true, products: (Array.isArray(data.products) ? data.products : []).filter(p => !BLOCKED.includes(p.id)).map(p => {
        const vars = Array.isArray(p.variants) ? p.variants : [];
        return Object.assign(sale(p.id, vars.length ? null : p.price, p.stock), { variants: vars.map(v => sale(v.id, v.price, v.stock)) });
      }) });
    }

    if (action === 'balance') {
      const { ok, data } = await api('/balance');
      if (!ok) {
        return res.status(502).json({ success: false, error: 'Consulta temporalmente no disponible.' });
      }
      return res.status(200).json({balance:data.balance,currency:data.currency});
    }

    if (action === 'order_status' || action === 'status') {
      const orderId = body.order_id || body.orderId || body.order;
      if (!orderId) {
        return res.status(400).json({ error: 'order_id requerido' });
      }
      const { ok, data } = await api('/orders/' + encodeURIComponent(orderId));
      if (!ok) {
        return res.status(502).json({ success: false, error: 'Consulta temporalmente no disponible.' });
      }
      return res.status(200).json({success:true,order_id:data.order_id || data.id || null,status:data.status});
    }

    return res.status(400).json({
      error: 'action inválida. Usá: order | products | balance | order_status'
    });
  } catch (err) {

    return res.status(500).json({
      success: false,
      error: 'Servicio temporalmente no disponible.'
    });
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

// v95: catálogo completo con nombres y costos SOLO para el panel del Owner (lo llama /api/game action=owner_costs, que ya verificó el rango)
module.exports.ownerCatalog = async function ownerCatalog() {
  const { ok, data } = await api('/products');
  if (!ok) return { ok: false };
  const R = await rules();
  return { ok: true, currency: /^(EUR|USD|USDT)$/.test(data.currency) ? data.currency : 'EUR', settings: R.s,
    products: (Array.isArray(data.products) ? data.products : []).filter(p => !BLOCKED.includes(p.id)).map(p => ({ id: p.id, name: String(p.name || '').slice(0, 120), cost: p.price, stock: p.stock,
      sale: (p.variants || []).length ? null : priceOf(p.id, p.price, R),
      variants: (Array.isArray(p.variants) ? p.variants : []).map(v => ({ id: v.id, name: String(v.name || '').slice(0, 120), cost: v.price, stock: v.stock, sale: priceOf(v.id, v.price, R) })) })) };
};
module.exports.priceOf = priceOf;
module.exports.QTY_ITEMS = QTY_ITEMS;
module.exports.BLOCKED = BLOCKED;
module.exports._resetRules = () => { rulesMem = { at: 0, v: null }; };

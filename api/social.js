

const SOCIAL_API_URL = 'https://bulkmedya.org/api/v2';

function getApiKey() {
  const key = process.env.BULK_MEDYA_API_KEY;
  if (!key) {
    throw new Error('Servicio temporalmente no disponible.');
  }
  return key;
}

async function callDelivery(params) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) body.set(k, String(v));
  }

  const res = await fetch(SOCIAL_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': 'KiwiiStore-Proxy/1.0'
    },
    body: body.toString()
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text, status: res.status };
  }
  return { ok: res.ok, status: res.status, data: json };
}

// ---------- v98: precios de redes calculados en el SERVIDOR (mismas tablas que la web + las que el Owner aplicó en COSTOS) ----------
// '1' = público · '0.5' = revendedor Nivel 1 · '0.25' = revendedor Nivel 2 (USDT por paquete). Son precios de Kiwii, no del servicio.
const PRICING = {
  escalera: { 100: 0.30, 500: 0.50, 1000: 0.80, 2000: 1.10, 5000: 1.50, 10000: 2.00, 20000: 2.60, 50000: 3.50, 100000: 5.00 },
  pisoRevendedor: { 1: 1, 0.5: 0.9, 0.25: 0.8 },
  tablas: {
    ig_seg_baja: { '1': { 100: 0.3, 500: 0.5, 1000: 0.8, 2000: 1.1, 5000: 1.5, 10000: 2.04, 20000: 4.02, 50000: 9.78 }, '0.5': { 100: 0.27, 500: 0.47, 1000: 0.72, 2000: 0.99, 5000: 1.35, 10000: 1.87, 20000: 3.71, 50000: 9.14 }, '0.25': { 100: 0.24, 500: 0.44, 1000: 0.64, 2000: 0.88, 5000: 1.2, 10000: 1.79, 20000: 3.56, 50000: 8.82 } },
    ig_seg_media: { '1': { 100: 0.5, 500: 1.13, 1000: 2.1, 2000: 4.13, 5000: 10.07, 10000: 19.32, 20000: 38, 50000: 92.58 }, '0.5': { 100: 0.47, 500: 0.97, 1000: 1.86, 2000: 3.68, 5000: 9.06, 10000: 17.71, 20000: 35.1, 50000: 86.54 }, '0.25': { 100: 0.44, 500: 0.89, 1000: 1.74, 2000: 3.45, 5000: 8.56, 10000: 16.91, 20000: 33.65, 50000: 83.52 } },
    ig_seg_premium: { '1': { 100: 0.8, 500: 2.35, 1000: 4.36, 2000: 8.58, 5000: 20.94, 10000: 40.2, 20000: 79.06, 50000: 192.63 }, '0.5': { 100: 0.77, 500: 2.01, 1000: 3.86, 2000: 7.64, 5000: 18.85, 10000: 36.85, 20000: 73.03, 50000: 180.07 }, '0.25': { 100: 0.74, 500: 1.85, 1000: 3.61, 2000: 7.17, 5000: 17.8, 10000: 35.18, 20000: 70.02, 50000: 173.79 } },
    ig_likes: { '1': { 500: 0.6, 1000: 0.9, 2000: 1.2, 5000: 1.6, 10000: 2.1, 20000: 3.31, 50000: 8.05, 100000: 15.68 }, '0.5': { 500: 0.55, 1000: 0.82, 2000: 1.09, 5000: 1.45, 10000: 1.9, 20000: 3.06, 50000: 7.53, 100000: 14.84 }, '0.25': { 500: 0.5, 1000: 0.74, 2000: 0.98, 5000: 1.3, 10000: 1.7, 20000: 2.93, 50000: 7.27, 100000: 14.42 } },
    ig_vistas: { '1': { 500: 0.5, 1000: 0.8, 2000: 1.1, 5000: 1.5, 10000: 2, 20000: 2.6, 50000: 3.5, 100000: 5 }, '0.5': { 500: 0.45, 1000: 0.72, 2000: 0.99, 5000: 1.35, 10000: 1.8, 20000: 2.34, 50000: 3.15, 100000: 4.5 }, '0.25': { 500: 0.4, 1000: 0.64, 2000: 0.88, 5000: 1.2, 10000: 1.6, 20000: 2.08, 50000: 2.8, 100000: 4 } },
    tt_likes: { '1': { 500: 0.6, 1000: 0.9, 2000: 1.31, 5000: 3.18, 10000: 6.11, 20000: 12.01, 50000: 29.24, 100000: 56.96 }, '0.5': { 500: 0.55, 1000: 0.82, 2000: 1.16, 5000: 2.87, 10000: 5.6, 20000: 11.09, 50000: 27.34, 100000: 53.91 }, '0.25': { 500: 0.5, 1000: 0.74, 2000: 1.09, 5000: 2.71, 10000: 5.34, 20000: 10.63, 50000: 26.38, 100000: 52.38 } },
    tt_vistas: { '1': { 500: 0.5, 1000: 0.8, 2000: 1.1, 5000: 1.5, 10000: 2, 20000: 2.6, 50000: 3.5, 100000: 5 }, '0.5': { 500: 0.45, 1000: 0.72, 2000: 0.99, 5000: 1.35, 10000: 1.8, 20000: 2.34, 50000: 3.15, 100000: 4.5 }, '0.25': { 500: 0.4, 1000: 0.64, 2000: 0.88, 5000: 1.2, 10000: 1.6, 20000: 2.08, 50000: 2.8, 100000: 4 } }
  }
};
const FACTOR = { 1: 0.5, 2: 0.25 };   // revendedor Nivel 1 / Nivel 2 (igual que la web)
const r2 = v => Math.round(v * 100) / 100;
let tablesMem = { at: 0, v: null };
async function tables() {   // tablas que el Owner marcó "Aplicar" en COSTOS (kiwi_price_overrides) pisan a las de siempre
  if (tablesMem.v && Date.now() - tablesMem.at < 5 * 60 * 1000) return tablesMem.v;
  const t = JSON.parse(JSON.stringify(PRICING.tablas));
  let o = null; try { o = await require('./_game-lib').sbSoft('kiwi_price_overrides', {}, 4000); } catch (_) { o = null; }
  const T = (o && o.tables) || {};
  for (const k of Object.keys(T)) if (t[k] && T[k] && T[k]['1']) t[k] = T[k];
  if (o) tablesMem = { at: Date.now(), v: t };
  return t;
}
function priceRaw(T, key, qty, f) {   // mismo cálculo que kiwiSocialPriceRaw de la web
  if (!key || !T[key] || !qty) return 0;
  const tt = T[key][String(f)] || T[key]['1'] || {};
  if (tt[qty] != null) return Number(tt[qty]);
  const qs = Object.keys(tt).map(Number).sort((a, b) => a - b); let near = 0; qs.forEach(q => { if (qty >= q) near = Number(tt[q]); });
  const E = PRICING.escalera, ks = Object.keys(E).map(Number).sort((a, b) => a - b); let pick = ks[0]; ks.forEach(k => { if (qty >= k) pick = k; });
  return Math.max(near, r2(E[pick] * (PRICING.pisoRevendedor[f] || 1)));
}

// referencia firmada del pedido en el servicio (la auto-sincronización solo consulta referencias firmadas por el servidor)
const crypto = require('crypto');
function refKey() { const s = String(process.env.KIWI_REF_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim(); return s.length >= 16 ? crypto.createHash('sha256').update('kiwi-ref|' + s).digest() : null; }
function signRef(id) {
  const k = refKey(), v = String(id == null ? '' : id);
  if (!k || !/^\d{1,20}$/.test(v)) return null;
  return 'S:' + v + '.' + crypto.createHmac('sha256', k).update('S|' + v).digest('hex').slice(0, 16);
}
function verifyRef(ref) {
  const m = /^S:(\d{1,20})\.([0-9a-f]{16})$/.exec(String(ref || '')); if (!m) return null;
  const good = signRef(m[1]); if (!good) return null;
  const a = Buffer.from(good), b = Buffer.from(String(ref));
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? m[1] : null;
}
const clean = (v, n) => String(v == null ? '' : v).replace(/[<>\u0000-\u001f]/g, ' ').trim().slice(0, n);

// ---------- v98: compra de redes con sesión, precio y cobro en el SERVIDOR (antes la web pedía al servicio sin sesión y se cobraba sola) ----------
async function buy(b, res) {
  const lib = require('./_game-lib');
  const token = String(b.token || ''), requestId = String(b.request_id || '');
  const key = String(b.line || ''), qty = Number(b.quantity), amount = Number(b.amount), link = String(b.link || '').trim();
  if (!token || token.length > 400) return res.status(401).json({ success: false, error: 'Iniciá sesión para comprar.' });
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(requestId)) return res.status(400).json({ success: false, error: 'Solicitud inválida.' });
  if (!Number.isInteger(qty) || qty < 10 || qty > 1000000) return res.status(400).json({ success: false, error: 'Cantidad inválida. No se descontó saldo.' });
  if (!/^\S{3,300}$/.test(link)) return res.status(400).json({ success: false, error: 'Revisá el link (sin espacios). No se descontó saldo.' });
  const dg = require('./digital'); const M = await dg.supplierMap();
  const line = M && M.social[key];
  if (!line) return res.status(M ? 400 : 503).json({ success: false, error: M ? 'Producto no disponible. Actualizá la página.' : 'Servicio temporalmente no disponible. No se descontó saldo.' });
  const T = await tables();
  const pub = priceRaw(T, key, qty, 1);
  if (!(pub > 0)) return res.status(400).json({ success: false, error: 'Producto no disponible. No se descontó saldo.' });
  let expected = pub, level = 0;
  if (b.reseller) {
    try { const st = await lib.sbSoft('kiwi_reseller_status', { p_token: token }, 4000); const l = st && st.ok && st.active ? Number(st.level) || 0 : 0; if (l >= 1) { level = Math.min(2, l); expected = priceRaw(T, key, qty, FACTOR[level]); } } catch (_) {}
  }
  const fits = x => Math.abs(amount - x) <= 0.011;
  if (!fits(expected)) {
    if (level && fits(pub)) { expected = pub; level = 0; }
    else return res.status(409).json({ success: false, code: 'PRICE_CHANGED', price: expected, error: 'El precio cambió: ' + qty.toLocaleString('es-AR') + ' = ' + expected.toFixed(2) + ' USDT. Actualizá la página. No se descontó saldo.' });
  }
  const orderId = String(Date.now() * 1000 + Math.floor(Math.random() * 1000));
  const row = { id: orderId, title: clean(b.title, 150) || (qty + ' ' + (line.title || key)), price: clean(b.price, 100) || expected.toFixed(2) + ' USDT', usdt: expected,
    method: 'Saldo Página', status: 'confirmed', target_user: link, extra: clean(b.extra, 300), category: line.category || 'instagram', date_str: clean(b.date_str, 60) };
  let ck;
  try { ck = await lib.sb('kiwi_checkout', { p_token: token, p_request_id: requestId, p_amount: expected, p_orders: [row] }, 15000); }
  catch (err) {
    const m = String(err.message || '');
    return res.status(/insuficiente/i.test(m) ? 402 : /sesi/i.test(m) ? 401 : 400).json({ success: false, error: /insuficiente/i.test(m) ? 'Saldo insuficiente.' : /sesi/i.test(m) ? 'Sesión inválida. Volvé a iniciar sesión.' : 'No se pudo cobrar. No se descontó saldo.' });
  }
  if (ck && ck.duplicate) return res.status(409).json({ success: false, code: 'DUPLICATE', balance: Number(ck.balance), error: 'Esta compra ya se procesó. Revisá Mis pedidos.' });
  let balance = Number(ck && ck.balance);
  const finish = async (result, extra) => { try { const r = await lib.sb('kiwi_digital_finish', Object.assign({ p_order_id: orderId, p_result: result }, extra || {})); if (r && r.balance != null) balance = Number(r.balance); return r; } catch (_) { return null; } };
  const base = { order_id: orderId, title: row.title, quantity: qty, price: expected, charged: true };
  let d = null, http = 0;
  try { const r = await callDelivery({ key: getApiKey(), action: 'add', service: line.service, link, quantity: qty }); d = r.data; http = r.status; } catch (_) { d = null; }
  const ref = d && d.order != null ? signRef(d.order) : null;
  if (ref) { await finish('pending', { p_ref: ref }); return res.status(200).json(Object.assign(base, { success: true, pending: true, status: 'processing', balance })); }
  if (d && d.error && http > 0 && http < 500) {   // el servicio lo rechazó (link inválido, cantidad fuera de rango…): no se entregó nada → devolver
    await finish('refund');
    return res.status(200).json(Object.assign(base, { success: false, refunded: true, balance, error: 'El servicio rechazó el pedido (revisá que el link sea público y correcto). Se devolvió el saldo.' }));
  }
  await finish('problem', { p_note: 'No pudimos confirmar el pedido con el servicio. El staff lo revisa y lo carga o te devuelve el saldo.' });
  lib.tg('⚠️ <b>Redes sin confirmar</b>\nPedido #' + orderId + ' · ' + lib.tgEsc(row.title) + ' · HTTP ' + http + '. Revisar en el servicio antes de devolver.').catch(() => {});
  return res.status(200).json(Object.assign(base, { success: false, problem: true, balance, error: 'No pudimos confirmar el pedido. El staff lo revisa (no compres de nuevo).' }));
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  let payload = req.body;
  if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { return res.status(400).json({ error: 'Invalid JSON body' }); } }
  if (!payload || typeof payload !== 'object') return res.status(400).json({ error: 'Missing body' });
  const action = String(payload.action || '').toLowerCase();

  try {
    // v98: 'add' (pedido al servicio SIN sesión y SIN cobro) cerrado → todo pasa por 'buy'. 'status' público quitado (lo revisa el servidor).
    if (action === 'add') return res.status(410).json({ success: false, code: 'UPDATE_PAGE', error: 'Actualizá la página (Ctrl+F5) para comprar. No se descontó saldo.' });
    if (action === 'buy') return await buy(payload, res);

    // v79: saldo y catálogo con costos SOLO con el secreto de admin (header x-pay-secret = PAY_NOTIF_SECRET).
    if (action === 'balance' || action === 'services') {
      const secret = String(process.env.PAY_NOTIF_SECRET || '');
      const given = String((req.headers && (req.headers['x-pay-secret'] || req.headers['x-admin-secret'])) || '');
      const a = Buffer.from(given), b = Buffer.from(secret);
      if (secret.length < 16 || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ success: false, error: 'no autorizado' });
      const apiKey = getApiKey();
      if (action === 'balance') {
        const { data } = await callDelivery({ key: apiKey, action: 'balance' });
        if (data?.error || data?.raw) return res.status(502).json({ success: false, error: 'Consulta temporalmente no disponible.' });
        return res.status(200).json({ balance: data.balance, currency: data.currency });
      }
      const { data } = await callDelivery({ key: apiKey, action: 'services' });
      if (!Array.isArray(data)) return res.status(502).json({ success: false, error: 'Catálogo temporalmente no disponible.' });
      return res.status(200).json(data.map(s => ({ service: s.service, type: s.type, rate: s.rate, min: s.min, max: s.max })));
    }
    return res.status(400).json({ error: 'action inválida.' });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Servicio temporalmente no disponible.' });
  }
};

// v94: consulta de estado para la sincronización automática del servidor (api/_auto-sync.js). No expone nada al público.
module.exports.statusOf = async function statusOf(order) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const body = new URLSearchParams({ key: getApiKey(), action: 'status', order: String(order) });
    const r = await fetch(SOCIAL_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': 'KiwiiStore-Proxy/1.0' }, body: body.toString(), signal: ctrl.signal });
    const text = await r.text(); let d; try { d = JSON.parse(text); } catch (_) { d = null; }
    if (!r.ok || !d || typeof d !== 'object') return { ok: false, http: r.status };
    if (d.error) return { ok: false, http: r.status, error: String(d.error).slice(0, 120), notFound: /incorrect|not found|invalid/i.test(String(d.error)) };
    return { ok: true, status: String(d.status || ''), remains: d.remains, start_count: d.start_count };
  } catch (e) { return { ok: false, http: 0, error: 'red' }; } finally { clearTimeout(t); }
};

// v95/v98: costo por 1000 de cada línea de redes, SOLO para el panel del Owner (lo llama /api/game action=owner_costs, que ya verificó el rango).
//  Responde por clave de línea (ig_seg_baja, tt_likes…): los códigos del servicio quedan en el servidor.
module.exports.ownerRates = async function ownerRates() {
  const M = await require('./digital').supplierMap(true);
  if (!M) return { ok: false };
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const body = new URLSearchParams({ key: getApiKey(), action: 'services' });
    const r = await fetch(SOCIAL_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': 'KiwiiStore-Proxy/1.0' }, body: body.toString(), signal: ctrl.signal });
    const d = await r.json().catch(() => null);
    if (!Array.isArray(d)) return { ok: false };
    const bySvc = {}; for (const s of d) bySvc[String(s.service)] = s;
    const out = {};
    for (const [k, l] of Object.entries(M.social)) { const s = bySvc[String(l.service)]; if (s) out[k] = { rate: Number(s.rate), min: Number(s.min), max: Number(s.max) }; }
    return { ok: true, rates: out };
  } catch (e) { return { ok: false }; } finally { clearTimeout(t); }
};
module.exports.verifyRef = verifyRef;
module.exports.signRef = signRef;
module.exports.priceRaw = priceRaw;
module.exports.PRICING = PRICING;
module.exports._reset = () => { tablesMem = { at: 0, v: null }; };

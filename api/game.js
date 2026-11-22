// v83: entrega automática (Free Fire, Blood Strike, PUBG Mobile, Mobile Legends) con el proveedor configurado por variables de entorno.
// v87: + productos nuevos (claves 1001–1999: juegos y gift cards con código) y verificación de ID con caché y límites por IP.
// Acciones (POST JSON, salvo webhook/cron):
//   validate  {product_id, player_id, zone_id}            -> nombre de la cuenta si el proveedor lo informa
//   buy       {token, request_id, amount, product_id, player_id, zone_id, order, reseller, qty}   (qty: solo fragmentos / cajas, 901 / 902)
//   status    {token, order_id}                           -> estado de un pedido propio (y lo avanza si toca revisar)
//   staff     {token}                                     -> staff: saldo del proveedor + últimos pedidos automáticos (+ revisa pendientes)
//   resolve   {token, order_id}                           -> staff (Owner/CEO): marcar como resuelto un pedido que quedó manual
//   ?action=webhook  (firma HMAC, CO_WEBHOOK_SECRET)      -> aviso del proveedor: se vuelve a consultar el pedido
//   GET ?action=cron (Authorization: Bearer CRON_SECRET)  -> revisión diaria de pendientes
//   v94: autosync {token}  -> revisa los pedidos automáticos del cliente (recargas, redes, streaming) y los marca "Completado"
//   v94: tick {}           -> cualquier visita: como mucho 1 vez por minuto (lo controla la base) avanza pendientes de todos
const lib = require('./_game-lib');
const auto = require('./_auto-sync');
const tickMem = { at: 0 }, syncMem = new Map();   // frenos por instancia (además del freno en la base)
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
const STOCK_ALIAS = { 5: 'p:200', 6: 'p:201', 7: 'p:202', 8: 'p:203', 9: 'p:204', 10: 'p:205', 901: 'ff:frag', 902: 'ff:box' };   // v85: fragmentos / cajas usan sus botones de siempre

// v87: qué datos pide cada producto (según su esquema): ID, Zona numérica, Servidor de una lista, o nada (gift card con código)
const ZONE_KEY = /zone|server|servidor|region/i;
function targetSpec(pid, it, schema) {
  const sch = Array.isArray(schema) && schema.length ? schema : ((it && it.fields) || []).map(k => ({ key: k, type: lib.isDyn(pid) && /^server$/i.test(k) ? 'select' : 'text' }));
  if (!sch.length) return it ? { player: false, zone: null } : { player: true, zone: lib.NEEDS_ZONE.has(pid) ? 'numeric' : null };
  const z = sch.find(f => f && ZONE_KEY.test(String(f.key || '')));
  return { player: sch.some(f => f && !ZONE_KEY.test(String(f.key || ''))), zone: z ? (z.type === 'select' ? 'select' : 'numeric') : (lib.NEEDS_ZONE.has(pid) ? 'numeric' : null) };
}
function checkPlayer(b, pid, spec) {
  spec = spec || { player: true, zone: lib.NEEDS_ZONE.has(pid) ? 'numeric' : null };
  if (!spec.player && !spec.zone) return { player: '', zone: '', none: true };
  const player = String(b.player_id == null ? '' : b.player_id).replace(/\s+/g, '');
  if (spec.player && !/^\d{4,20}$/.test(player)) return { error: 'ID de jugador inválido (solo números).' };
  let zone = String(b.zone_id == null ? '' : b.zone_id).trim();
  if (spec.zone === 'numeric') { zone = zone.replace(/\s+/g, ''); if (!/^\d{1,8}$/.test(zone)) return { error: 'Falta la Zona / Servidor (solo números).' }; }
  else if (spec.zone === 'select') { if (!/^[A-Za-z0-9 _,\/-]{1,40}$/.test(zone)) return { error: 'Elegí tu Servidor.' }; }
  else zone = '';
  return { player, zone };
}
// v87: tope de pedidos de verificación por IP (además de los límites hacia el proveedor en _game-lib)
const ipHits = new Map();
function ipOk(ip) {
  const k = lib.ipHash(ip), now = Date.now(), a = (ipHits.get(k) || []).filter(t => now - t < 60000);
  if (a.length >= 20) { ipHits.set(k, a); return false; }
  a.push(now); ipHits.set(k, a); if (ipHits.size > 5000) ipHits.delete(ipHits.keys().next().value);
  return true;
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
    const out = lib.provReady() ? await lib.sweep(20).catch(() => []) : [];
    const more = await auto.syncDue({ limit: 25, budgetMs: 7000 }).catch(() => []);   // v94: redes y streaming
    await auto.postReviewInvites(10).catch(() => 0);
    return send(res, 200, { ok: true, checked: out.length + more.length });
  }

  if (req.method !== 'POST') return send(res, 405, { success: false, error: 'Método no permitido' });
  const b = await readBody(req);
  if (!b || typeof b !== 'object') return send(res, 400, { success: false, error: 'JSON inválido' });
  const action = String(b.action || '');

  // ---- v95: panel "Costos y márgenes" (SOLO Owner: la base verifica el rango con el token). Costos en vivo de los 3 proveedores. ----
  if (action === 'owner_costs') {
    const token = clean(b.token, 200);
    let cfg = null;
    try { cfg = await lib.sb('kiwi_cost_get', { p_token: token }, 8000); } catch (_) { cfg = null; }
    if (!cfg || !cfg.ok) return send(res, 403, { ok: false, error: 'Solo el Owner.' });
    const out = { ok: true, settings: cfg.settings, items: cfg.items, games: [], digital: null, social: null };
    try {
      const d = await lib.getCosts({ force: !!b.fresh });
      const inactive = new Set((d.inactive || []).map(Number));
      for (const id of lib.allIds()) {
        const c = Number(d.costs && d.costs[id]); const m = lib.meta(id);
        const bulk = lib.isBulk(id);
        const price = c > 0 ? (bulk ? lib.bulkUnit(c, id, 0) : lib.salePrice(c, id)) : null;
        out.games.push({ id, title: m && m.title || null, category: lib.CATEGORY_OF(id), cost: c > 0 ? c : null, price, bulk,
          pct: c > 0 && price ? Math.round((price / c - 1) * 10000) / 100 : null, rule: lib.ruleOf ? lib.ruleOf(id) : null, inactive: inactive.has(id) || !(c > 0) });
      }
      out.games_live = !!d.live; out.games_source = d.source || null;
    } catch (_) {}
    const dg = (() => { try { return require('./digital'); } catch (_) { return null; } })();
    const so = (() => { try { return require('./social'); } catch (_) { return null; } })();
    const [dr, sr] = await Promise.all([
      dg && dg.ownerCatalog ? dg.ownerCatalog().catch(() => null) : null,
      so && so.ownerRates ? so.ownerRates(Array.isArray(b.social_ids) ? b.social_ids.slice(0, 20) : []).catch(() => null) : null
    ]);
    out.digital = dr && dr.ok ? dr : { ok: false };
    out.social = sr && sr.ok ? sr : { ok: false };
    return send(res, 200, out);
  }

  // ---- v94: el cliente abre la web / Mis pedidos: revisar SUS pedidos automáticos pendientes ----
  if (action === 'autosync') {
    const token = String(b.token || '');
    if (!token || token.length > 200) return send(res, 400, { success: false, error: 'Solicitud inválida.' });
    const k = require('crypto').createHash('sha256').update(token).digest('hex').slice(0, 24);
    if (Date.now() - (syncMem.get(k) || 0) < 15000) return send(res, 200, { success: true, orders: [], throttled: true });
    syncMem.set(k, Date.now()); if (syncMem.size > 2000) syncMem.clear();
    let orders = [];
    try { orders = await auto.syncDue({ token, limit: 6, budgetMs: 5000 }); }
    catch (e) {
      if (/sesi[oó]n|token/i.test(e.message)) return send(res, 401, { success: false, error: 'Sesión inválida.' });
      if (/does not exist|PGRST202|Could not find/i.test(e.message)) return send(res, 200, { success: false, code: 'SQL_MISSING', orders: [] });
      return send(res, 200, { success: false, orders: [] });
    }
    if (lib.provReady()) { try { await lib.sweep(2); } catch (_) {} }
    auto.postReviewInvites(3).catch(() => 0);
    return send(res, 200, { success: true, orders });
  }
  // ---- v94: "latido" de cualquier visita: avanza los pendientes de todos aunque el comprador cerró la página ----
  if (action === 'tick') {
    if (Date.now() - tickMem.at < 20000) return send(res, 200, { ok: true, ran: false });
    tickMem.at = Date.now();
    let go = false;
    try { go = await lib.sb('kiwi_auto_tick_claim', { p_seconds: 60 }, 4000) === true; } catch (_) { go = false; }
    if (!go) return send(res, 200, { ok: true, ran: false });
    let n = 0;
    if (lib.provReady()) { try { n += (await lib.sweep(4)).length; } catch (_) {} }
    try { n += (await auto.syncDue({ limit: 6, budgetMs: 5000 })).length; } catch (_) {}
    try { await auto.postReviewInvites(5); } catch (_) {}
    return send(res, 200, { ok: true, ran: true, checked: n });
  }

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
  if (!lib.knownId(pid)) return send(res, 400, { success: false, error: 'Producto no permitido' });
  const ip = lib.clientIp(req.headers);

  if (action === 'validate') {
    try {
      if (!ipOk(ip)) return send(res, 429, { success: false, status: 'unverified', throttled: true, account_name: null, error: 'Demasiadas verificaciones seguidas. Esperá un minuto.' });
      const { it, schema } = await itemFor(pid);
      if (!it) return send(res, 200, { success: false, supported: false, account_name: null });
      const spec = targetSpec(pid, it, schema);
      const pl = checkPlayer(b, pid, spec);
      if (pl.error) return send(res, 400, { success: false, error: pl.error });
      if (pl.none) return send(res, 200, { success: true, supported: false, status: 'unverified', account_name: null, no_target: true });
      const t = lib.buildTarget(it.fields, schema, pl.player, pl.zone);
      if (t.error) return send(res, 200, { success: false, supported: true, status: 'invalid', account_name: null, error: t.error });
      const v = await lib.verifyPlayer(it.ref, t.payload, ip);
      return send(res, 200, { success: true, supported: !(v.unsupported || v.throttled || (v.status === 'unverified')), status: v.status, account_name: v.name || null, throttled: !!v.throttled });
    } catch (e) { return send(res, 200, { success: false, supported: false, status: 'unverified', account_name: null }); }
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
  const spec = targetSpec(pid, it, schema);
  const pl = checkPlayer(b, pid, spec);
  if (pl.error) return send(res, 400, { success: false, error: pl.error });
  if (live.source === 'fallback') return send(res, 503, { success: false, stage: 'checkout', code: 'PRICES_UNVERIFIED', error: 'No pudimos confirmar el precio. Probá en unos minutos. No se descontó saldo.' });
  if (!it || (live.inactive || []).includes(pid) || !(Number(live.costs[pid]) > 0)) return send(res, 409, { success: false, stage: 'checkout', code: 'PRODUCT_INACTIVE', error: 'Producto agotado / no disponible.' });
  // v85: fragmentos / cajas por cantidad → varios paquetes en un solo pedido
  const bulk = lib.isBulk(pid);
  const qty = bulk ? Number(b.qty) : 1;
  let plan = null;
  if (bulk) {
    const qe = lib.qtyError(pid, qty, lib.bulkRules(pid, (live.packs || {})[pid]));
    if (qe) return send(res, 400, { success: false, stage: 'checkout', error: qe + ' No se descontó saldo.' });
    plan = lib.bulkPlan((live.packs || {})[pid], qty);
    if (!plan) return send(res, 409, { success: false, stage: 'checkout', code: 'PRODUCT_INACTIVE', error: 'Producto agotado / no disponible.' });
  }
  const unitCost = Number(live.costs[pid]);
  const cost = bulk ? plan.cost : unitCost;
  const priceFor = (lvl) => bulk ? lib.bulkPrice(unitCost, pid, qty, lvl) : (lvl ? lib.resellerSalePrice(cost, pid, lvl) : lib.salePrice(cost, pid));
  const publicPrice = priceFor(0);
  if (!(publicPrice > 0)) return send(res, 409, { success: false, stage: 'checkout', code: 'PRODUCT_INACTIVE', error: 'Producto agotado / no disponible.' });
  const fits = (exp) => !(amount + 1e-9 < cost || amount < exp * (1 - lib.TOLERANCE) - 1e-9 || amount > exp * (1 + lib.TOLERANCE) + 0.01);
  let expected = publicPrice, resellerLevel = 0;
  if (b.reseller) {
    try {
      const st = await supaRpc('kiwi_reseller_status', { p_token: token });
      const j = st.ok ? st.json : null;
      const lvl = j && j.ok && j.active ? Number(j.level) || 0 : 0;
      if (lvl >= 1) { resellerLevel = Math.min(2, lvl); expected = priceFor(resellerLevel); }
    } catch (_) {  }
  }
  if (!fits(expected)) {
    if (resellerLevel && fits(publicPrice)) { expected = publicPrice; resellerLevel = 0; }
    else return send(res, 409, { success: false, stage: 'checkout', code: 'PRICE_CHANGED', price: expected, reseller_level: resellerLevel, error: 'El precio cambió. Actualizá la página (nuevo precio: ' + expected.toFixed(2) + ' USDT).' });
  }
  const tgt = pl.none ? { payload: {} } : lib.buildTarget(it.fields, schema, pl.player, pl.zone);
  if (tgt.error) return send(res, 400, { success: false, stage: 'checkout', error: tgt.error + ' No se descontó saldo.' });

  // Antes de cobrar: saldo del proveedor (si no alcanza, no se vende) y verificación del ID (solo bloquea si es inválido)
  if (!/^(0|off|no|false)$/i.test(String(process.env.PROV_BALANCE_CHECK || ''))) {
    const bal = await lib.provBalance(false);
    if (bal && Number.isFinite(bal.available) && bal.available + 1e-9 < cost) {
      if (Date.now() - lowAlertAt > 30 * 60 * 1000) { lowAlertAt = Date.now(); lib.tg('⚠️ <b>Saldo del proveedor insuficiente</b>: ' + bal.available.toFixed(2) + ' ' + lib.tgEsc(bal.currency) + '. Se rechazó una compra automática de ' + cost.toFixed(2) + '. Recargá saldo en el proveedor. (Aviso cada 30 min como máximo.)').catch(() => {}); }
      return send(res, 503, { success: false, stage: 'checkout', code: 'NO_STOCK', error: 'Sin stock temporal de este producto. No se descontó saldo.' });
    }
  }
  const pv = pl.none ? { status: 'unverified', name: null } : await lib.verifyPlayer(it.ref, tgt.payload, ip).catch(() => ({ status: 'unverified' }));
  if (pv.status === 'invalid') return send(res, 400, { success: false, stage: 'checkout', code: 'INVALID_PLAYER', error: 'Ese ID de jugador no existe' + (spec.zone ? ' (o la Zona / Servidor no corresponde)' : '') + '. Revisalo. No se descontó saldo.' });

  const target = pl.none ? 'Código digital' : 'ID ' + pl.player + (pl.zone ? (spec.zone === 'select' ? ' · Servidor ' : ' · Zona ') + pl.zone : '');
  const name = pl.none ? '' : (clean(order.name, 60) || (pv.name || ''));
  const m = lib.meta(pid);
  const row = {
    id: orderId,
    title: bulk ? lib.BULK[pid].label + ' x' + qty : ((m && m.title) || clean(order.title, 200)),
    price: clean(order.price, 100),
    method: 'Saldo (entrega automática)',
    status: 'confirmed',
    target_user: target,
    extra: (pl.none ? 'Entrega automática · código en Mis pedidos' : 'Entrega automática · ' + target) + (name ? ' · Nombre: ' + name : ''),
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
  try { rec = await lib.sb('kiwi_prov_order_create', Object.assign({ p_order_id: orderId, p_kiwi_key: pid, p_product_ref: it.ref, p_target: tgt.payload, p_cost: cost, p_pin: !!it.pin }, plan ? { p_lines: plan.lines } : {})); }
  catch (e) {
    lib.tg('⚠️ <b>Entrega automática sin registrar</b> (falta kiwii-v85.sql?)\nPedido #' + lib.tgEsc(orderId) + ' · ' + lib.tgEsc(row.title) + '\n' + lib.tgEsc(e.message)).catch(() => {});
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

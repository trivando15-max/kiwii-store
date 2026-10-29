// KIWII STORE v54 - Recargas de saldo automáticas (Vercel serverless, Node 18+, sin dependencias)
// UNA sola función con acciones (?action=... o { action } en el JSON):
//   GET  config                                  -> métodos activos y datos para pagar (salen de variables de entorno)
//   POST create  { token, method, usdt }         -> crea la recarga con monto único y tasa congelada
//   POST confirm { token, id, reference, payer_name?, proof? } -> "Ya pagué" (+ verificación automática USDT/Binance Pay)
//   POST check   { token, id }                   -> vuelve a verificar / devuelve el estado
//   POST notif   (header x-pay-secret)           -> notificación reenviada por el celular (transferencias)
// El saldo SOLO lo suma la base (kiwi_pay_credit). Este archivo nunca confía en la imagen del comprobante.
const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ykxyiamlvlppcyfzyvzr.supabase.co';
const env = (k, d) => { const v = process.env[k]; return v == null || String(v).trim() === '' ? (d === undefined ? '' : d) : String(v).trim(); };
const USDT_TRC20_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const BINANCE_BASE = 'https://api.binance.com';

// ---------- Métodos ----------
// step = "centavo único" que se suma para distinguir pagos; round = redondeo del monto base
const METHODS = {
  usdt:           { label: 'USDT (TRC20 / BEP20)', currency: 'USDT', step: 0.01, round: 0.01, kind: 'crypto' },
  binance_pay:    { label: 'Binance Pay',          currency: 'USDT', step: 0.01, round: 0.01, kind: 'binance_pay' },
  ar_transfer:    { label: 'Transferencia Argentina (alias)', currency: 'ARS', step: 1, round: 10, kind: 'notif' },
  mx_nu:          { label: 'Nu México (SPEI)',      currency: 'MXN', step: 0.01, round: 0.1, kind: 'notif' },
  co_bancolombia: { label: 'Bancolombia',           currency: 'COP', step: 1, round: 100, kind: 'notif' },
  pe_yape:        { label: 'Yape (Perú)',           currency: 'PEN', step: 0.01, round: 0.1, kind: 'notif' },
};
// Comisiones iguales a las del modal "Cargar Saldo" (BALANCE_COMMISSION). Se pueden cambiar con PAY_COMMISSION_JSON.
const DEFAULT_COMMISSION = { USDT: 1, ARS: 0, MXN: 6, COP: 4, PEN: 4 };
// Margen sobre P2P igual al de la web (KIWI_RATE_MARGIN)
const RATE_MARGIN = { ARS: 1.00, MXN: 1.0143, COP: 1.0343, PEN: 1.009 };
const P2P = { ARS: { payTypes: [], transAmount: 16500 }, MXN: { payTypes: ['BBVABank'], transAmount: 190 },
  COP: { payTypes: ['BancolombiaSA'], transAmount: 32000 }, PEN: { payTypes: ['Yape'], transAmount: 35 } };

function jsonEnv(k, d) { try { const v = env(k); return v ? Object.assign({}, d, JSON.parse(v)) : d; } catch (_) { return d; } }
function accountData(m) {
  // Datos de cobro: SOLO desde variables de entorno. Si faltan, el método no se muestra.
  switch (m) {
    case 'usdt': {
      const rows = [];
      if (env('PAY_DEPOSIT_ADDRESS_TRC20')) rows.push(['Red TRON (TRC20)', env('PAY_DEPOSIT_ADDRESS_TRC20')]);
      if (env('PAY_DEPOSIT_ADDRESS_BEP20')) rows.push(['Red BNB Smart Chain (BEP20)', env('PAY_DEPOSIT_ADDRESS_BEP20')]);
      const verifiable = !!((env('BINANCE_API_KEY') && env('BINANCE_API_SECRET')) || env('PAY_DEPOSIT_ADDRESS_TRC20'));
      return rows.length && verifiable ? rows : null;
    }
    case 'binance_pay':
      return env('PAY_BINANCE_PAY_ID') && env('BINANCE_API_KEY') && env('BINANCE_API_SECRET')
        ? [['Binance Pay ID', env('PAY_BINANCE_PAY_ID')]].concat(env('PAY_BINANCE_PAY_NAME') ? [['Nombre', env('PAY_BINANCE_PAY_NAME')]] : []) : null;
    case 'ar_transfer':
      return env('PAY_AR_ALIAS') ? [['Alias', env('PAY_AR_ALIAS')]].concat(env('PAY_AR_CVU') ? [['CVU/CBU', env('PAY_AR_CVU')]] : [], env('PAY_AR_TITULAR') ? [['Titular', env('PAY_AR_TITULAR')]] : [], env('PAY_AR_BANCO') ? [['Banco / billetera', env('PAY_AR_BANCO')]] : []) : null;
    case 'mx_nu':
      return env('PAY_MX_CLABE') ? [['CLABE', env('PAY_MX_CLABE')], ['Banco', 'Nu México']].concat(env('PAY_MX_TITULAR') ? [['Titular', env('PAY_MX_TITULAR')]] : []) : null;
    case 'co_bancolombia':
      return env('PAY_CO_CUENTA') ? [['Cuenta Bancolombia', env('PAY_CO_CUENTA')], ['Tipo', env('PAY_CO_TIPO', 'Ahorros')]].concat(env('PAY_CO_TITULAR') ? [['Titular', env('PAY_CO_TITULAR')]] : [], env('PAY_CO_DOCUMENTO') ? [['Documento', env('PAY_CO_DOCUMENTO')]] : []) : null;
    case 'pe_yape':
      return env('PAY_PE_YAPE_NUMERO') ? [['Celular Yape', env('PAY_PE_YAPE_NUMERO')]].concat(env('PAY_PE_TITULAR') ? [['Titular', env('PAY_PE_TITULAR')]] : []) : null;
  }
  return null;
}
function publicConfig() {
  const comm = jsonEnv('PAY_COMMISSION_JSON', DEFAULT_COMMISSION);
  const methods = [];
  for (const [id, m] of Object.entries(METHODS)) {
    const acc = accountData(id);
    if (acc) methods.push({ id, label: m.label, currency: m.currency, commission_pct: Number(comm[m.currency]) || 0, account: acc });
  }
  return { ok: true, methods, min_usdt: Number(env('PAY_MIN_USDT', '1')) || 1, max_usdt: Number(env('PAY_MAX_USDT', '500')) || 500,
           minutes: Number(env('PAY_EXPIRY_MINUTES', '45')) || 45 };
}

// ---------- HTTP helpers (mismo estilo que api/ra.js) ----------
function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (_) { return { _raw: req.body }; } }
  const chunks = []; let n = 0;
  for await (const c of req) { chunks.push(c); n += c.length; if (n > 900000) return null; }
  const s = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(s || '{}'); } catch (_) { return { _raw: s }; }
}
let _fetch = (...a) => fetch(...a);
async function fetchJson(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 15000);
  try {
    const r = await _fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch (_) { json = { raw: text.slice(0, 300) }; }
    return { ok: r.ok, status: r.status, json };
  } finally { clearTimeout(t); }
}
async function supaRpc(fn, args) {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!key) throw new Error('Falta SUPABASE_SERVICE_ROLE_KEY en Vercel.');
  const r = await fetchJson(SUPABASE_URL + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: { 'apikey': key, 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(args)
  }, 15000);
  if (!r.ok) throw new Error(clean((r.json && (r.json.message || r.json.error)) || ('Supabase ' + r.status), 300));
  return r.json;
}
const clean = (s, n) => String(s == null ? '' : s).replace(/[<>]/g, '').trim().slice(0, n);
const round = (x, step) => Math.round(Math.round(x / step) * step * 100) / 100;

// ---------- Cotización (misma fuente que /api/binance-p2p) ----------
async function p2pRate(fiat) {
  const cfg = P2P[fiat];
  const tries = [[cfg.payTypes, cfg.transAmount], [[], cfg.transAmount], [[], null]];
  for (const [payTypes, transAmount] of tries) {
    try {
      const body = { fiat, asset: 'USDT', tradeType: 'BUY', page: 1, rows: 10, payTypes, publisherType: null };
      if (transAmount) body.transAmount = transAmount;
      const r = await fetchJson('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search',
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' }, body: JSON.stringify(body) }, 8000);
      const prices = ((r.json && r.json.data) || []).map(a => Number(a.adv && a.adv.price)).filter(n => n > 0).sort((a, b) => a - b).slice(0, 5);
      if (prices.length) return prices.reduce((s, p) => s + p, 0) / prices.length;
    } catch (_) {}
  }
  return null;
}
async function getRate(currency) {
  if (currency === 'USDT') return 1;
  const fixed = jsonEnv('PAY_FIXED_RATES_JSON', {});        // opcional: tasa manual { "ARS": 1650 }
  if (Number(fixed[currency]) > 0) return Number(fixed[currency]);
  const base = await p2pRate(currency);
  if (!base) return null;
  const m = Number(jsonEnv('PAY_RATE_MARGIN_JSON', RATE_MARGIN)[currency]) || 1;
  return Math.round(base * m * 1000) / 1000;
}
function quote(method, usdt, rate) {
  const m = METHODS[method];
  const comm = Number(jsonEnv('PAY_COMMISSION_JSON', DEFAULT_COMMISSION)[m.currency]) || 0;
  const base = round(usdt * (1 + comm / 100) * rate, m.round);
  return { base, commission: comm, step: m.step };
}

// ---------- Binance (firma HMAC-SHA256, solo lectura) ----------
function binanceSign(query, secret) { return crypto.createHmac('sha256', secret).update(query).digest('hex'); }
async function binanceGet(path, params) {
  const key = env('BINANCE_API_KEY'), secret = env('BINANCE_API_SECRET');
  if (!key || !secret) return { ok: false, status: 0, json: { msg: 'Binance no configurado' } };
  const q = new URLSearchParams(Object.assign({}, params, { recvWindow: 10000, timestamp: Date.now() })).toString();
  return fetchJson(BINANCE_BASE + path + '?' + q + '&signature=' + binanceSign(q, secret), { headers: { 'X-MBX-APIKEY': key } }, 12000);
}
// Compara lo recibido con lo esperado. Exacto (±0.009) -> acredita. Distinto -> revisión del staff.
function judge(expected, received) {
  if (!(received > 0)) return 'none';
  return Math.abs(received - expected) < 0.01 ? 'ok' : 'mismatch';
}
const normTx = s => String(s || '').trim().replace(/^0x/i, '').toLowerCase();

async function checkBinanceDeposit(topup, txid) {
  const created = Date.parse(topup.created_at);
  const r = await binanceGet('/sapi/v1/capital/deposit/hisrec', { coin: 'USDT', txId: txid, startTime: created - 15 * 60000 });
  if (!r.ok || !Array.isArray(r.json)) return { found: false, error: 'binance ' + r.status };
  const d = r.json.find(x => normTx(x.txId) === normTx(txid) || normTx(String(x.txId).split(' ')[0]) === normTx(txid));
  if (!d) return { found: false };
  if (String(d.coin).toUpperCase() !== 'USDT') return { found: true, verdict: 'mismatch', note: 'No es USDT' };
  if (!(d.status === 1 || d.status === 6)) return { found: true, verdict: 'wait', note: 'Depósito pendiente en Binance (estado ' + d.status + ')' };
  if (Number(d.insertTime) < created - 5 * 60000) return { found: true, verdict: 'mismatch', note: 'Depósito anterior a la recarga' };
  const amt = Number(d.amount);
  return { found: true, verdict: judge(Number(topup.pay_amount), amt), amount: amt, source: 'binance_deposit', network: d.network };
}
async function checkTronGrid(topup, txid) {
  const addr = env('PAY_DEPOSIT_ADDRESS_TRC20');
  if (!addr) return { found: false };
  const created = Date.parse(topup.created_at);
  const url = 'https://api.trongrid.io/v1/accounts/' + encodeURIComponent(addr) + '/transactions/trc20?only_confirmed=true&only_to=true&limit=200'
    + '&contract_address=' + USDT_TRC20_CONTRACT + '&min_timestamp=' + (created - 15 * 60000);
  const headers = env('TRONGRID_API_KEY') ? { 'TRON-PRO-API-KEY': env('TRONGRID_API_KEY') } : {};
  const r = await fetchJson(url, { headers }, 12000);
  if (!r.ok || !r.json || !Array.isArray(r.json.data)) return { found: false, error: 'trongrid ' + r.status };
  const t = r.json.data.find(x => normTx(x.transaction_id) === normTx(txid));
  if (!t) return { found: false };
  if (!t.token_info || t.token_info.address !== USDT_TRC20_CONTRACT) return { found: true, verdict: 'mismatch', note: 'Token distinto de USDT' };
  if (t.to !== addr) return { found: true, verdict: 'mismatch', note: 'Destino distinto' };
  if (Number(t.block_timestamp) < created - 5 * 60000) return { found: true, verdict: 'mismatch', note: 'Transferencia anterior a la recarga' };
  const amt = Number(t.value) / Math.pow(10, Number((t.token_info && t.token_info.decimals) || 6));
  return { found: true, verdict: judge(Number(topup.pay_amount), amt), amount: amt, source: 'trongrid', network: 'TRX' };
}
// Binance Pay: historial de pagos (GET /sapi/v1/pay/transactions). Recibidos = amount > 0.
async function checkBinancePay(topup, orderId) {
  const created = Date.parse(topup.created_at);
  const r = await binanceGet('/sapi/v1/pay/transactions', { startTime: created - 5 * 60000, endTime: Date.now(), limit: 100 });
  const list = r.ok && r.json && Array.isArray(r.json.data) ? r.json.data : null;
  if (!list) return { found: false, error: 'binance pay ' + r.status };
  const inc = list.filter(x => Number(x.amount) > 0 && String(x.currency).toUpperCase() === 'USDT' && Number(x.transactionTime) >= created - 5 * 60000);
  let t = orderId ? inc.find(x => normTx(x.transactionId) === normTx(orderId) || normTx(x.orderId) === normTx(orderId)) : null;
  if (!t) {
    const same = inc.filter(x => Math.abs(Number(x.amount) - Number(topup.pay_amount)) < 0.005);
    if (same.length === 1) t = same[0]; else if (same.length > 1) return { found: true, verdict: 'mismatch', note: 'Varios pagos con el mismo monto' };
  }
  if (!t) return { found: false };
  return { found: true, verdict: judge(Number(topup.pay_amount), Number(t.amount)), amount: Number(t.amount), source: 'binance_pay',
           ref: String(t.transactionId || ''), payer: t.payerInfo && t.payerInfo.name };
}

async function verifyTopup(topup) {
  if (!topup || !['submitted', 'pending', 'expired'].includes(topup.status)) return topup;
  const m = METHODS[topup.method];
  if (!m || m.kind === 'notif') return topup;
  const ref = topup.reference;
  let res = { found: false };
  if (m.kind === 'crypto') {
    if (!ref) return topup;
    if (env('BINANCE_API_KEY')) res = await checkBinanceDeposit(topup, ref);
    if (!res.found) { const t = await checkTronGrid(topup, ref); if (t.found) res = t; }
  } else {
    res = await checkBinancePay(topup, ref);
  }
  if (!res.found || res.verdict === 'wait') {
    const out = await supaRpc('kiwi_pay_mark', { p_id: topup.id, p_status: null, p_note: res.note || null, p_received: null });
    return out;
  }
  if (res.verdict === 'ok') {
    const key = topup.method + ':' + normTx(res.ref || ref).replace(/[^a-z0-9]/g, '');
    const out = await supaRpc('kiwi_pay_credit', { p_id: topup.id, p_source: res.source, p_ref_key: key, p_notif_id: null,
      p_usdt: null, p_by: 'auto', p_received: res.amount });
    return out.topup || out;
  }
  return supaRpc('kiwi_pay_mark', { p_id: topup.id, p_status: 'review',
    p_note: res.note || ('Monto recibido ' + res.amount + ' distinto de ' + topup.pay_amount), p_received: res.amount || null });
}

// ---------- Notificaciones de bancos (parsers tolerantes, configurables) ----------
const DEFAULT_APPS = {
  'com.mercadopago.wallet': 'ar_transfer', 'com.uala': 'ar_transfer', 'ar.com.brubank.wallet': 'ar_transfer',
  'com.nu.production': 'mx_nu', 'mx.com.nu': 'mx_nu',
  'com.todo1.mobile': 'co_bancolombia', 'com.bancolombia.app': 'co_bancolombia',
  'com.bcp.innovacxion.yapeapp': 'pe_yape',
};
const CUR_OF = { ar_transfer: 'ARS', mx_nu: 'MXN', co_bancolombia: 'COP', pe_yape: 'PEN' };
const INCOMING = /(recibiste|te (?:envi[oó]|enviaron|transfiri[oó]|pag[oó]|yape[oó])|te lleg[oó]|ingres[oó]|ingreso|abono|abonaron|recibido|recibimos|dep[oó]sito recibido|transferencia recibida|has recibido)/i;
const OUTGOING = /(enviaste|pagaste|transferiste|yapeaste|realizaste|compra|retiro|d[eé]bito|cargo|pago de servicio|te cobr)/i;

// "$ 16.501", "16.501,50", "$1,234.56", "S/ 35.5", "COP 32.001" -> número
function parseAmountStr(s) {
  s = String(s).replace(/[^\d.,]/g, '').replace(/[.,]+$/, '');
  if (!s) return null;
  const lastDot = s.lastIndexOf('.'), lastCom = s.lastIndexOf(',');
  const last = Math.max(lastDot, lastCom);
  let intPart = s, dec = '';
  if (last >= 0) {
    const after = s.slice(last + 1);
    const both = lastDot >= 0 && lastCom >= 0;
    if (both || after.length !== 3) { intPart = s.slice(0, last); dec = after; }
  }
  intPart = intPart.replace(/[.,]/g, '');
  const n = Number(intPart + (dec ? '.' + dec : ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}
function parseNotification(n, forcedMethod) {
  const app = clean(n.package || n.packageName || n.app_package || n.app || '', 120);
  const title = clean(n.title || '', 300);
  const text = clean([n.big_text || n.bigText, n.text, n.sub_text || n.subText].filter(Boolean).join(' · ') || n.message || n._raw || '', 2000);
  const apps = jsonEnv('PAY_NOTIF_APPS_JSON', DEFAULT_APPS);
  let method = METHODS[forcedMethod] && METHODS[forcedMethod].kind === 'notif' ? forcedMethod : (apps[app] || null);
  const all = (title + ' · ' + text).replace(/\s+/g, ' ');
  const out = { app, title, text, method, amount: null, currency: method ? CUR_OF[method] : null, sender: null, op: null, incoming: false };
  out.incoming = INCOMING.test(all) && !(OUTGOING.test(all) && !INCOMING.test(all.replace(OUTGOING, '')));
  if (!out.incoming) return out;
  const am = all.match(/(?:S\/\.?|\$|COP|MXN|ARS|PEN|soles?)\s*([\d][\d.,]*)/i) || all.match(/([\d][\d.,]*)\s*(?:pesos|soles|COP|MXN|ARS|PEN)/i);
  if (am) out.amount = parseAmountStr(am[1]);
  const snd = all.match(/([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ.]*){0,3})\s+te\s+(?:envi|transfiri|yape|pag)/)
           || all.match(/(?:\bde|desde)\s+([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ.]+(?:\s+[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ.]*){0,3})/);
  if (snd) out.sender = snd[1].trim();
  const op = all.match(/(?:operaci[oó]n|n[uú]mero de operaci[oó]n|referencia|ref\.?|c[oó]digo|comprobante|folio|clave de rastreo)\s*(?:n[°º.o]*|#|:)?\s*([A-Za-z0-9-]{4,40})/i);
  if (op) out.op = op[1];
  return out;
}
function notifHash(n, p) {
  const key = n.key || n.notificationKey || n.id || '';
  const t = n.post_time || n.postedAt || n.timestamp || n.when || '';
  const basis = (key || t) ? [p.app, key, t, p.title, p.text].join('|') : [p.app, p.title, p.text, Math.floor(Date.now() / 60000)].join('|');
  return crypto.createHash('sha256').update(basis).digest('hex');
}
function safeEq(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------- Router ----------
async function handler(req, res) {
  try {
    const q = req.query || Object.fromEntries(new URL(req.url, 'http://x').searchParams);
    const body = req.method === 'GET' ? {} : (await readBody(req)) || {};
    const action = String(q.action || body.action || (req.method === 'GET' ? 'config' : '')).toLowerCase();

    if (action === 'config') return send(res, 200, publicConfig());

    if (action === 'notif') {
      const secret = env('PAY_NOTIF_SECRET');
      const given = req.headers['x-pay-secret'] || q.s || '';
      if (!secret || secret.length < 16 || !safeEq(given, secret)) return send(res, 401, { error: 'no autorizado' });
      if (body.test === true || /^test$/i.test(String(body.title || ''))) return send(res, 200, { ok: true, test: true });
      const p = parseNotification(body, String(q.m || body.method || ''));
      const posted = Date.parse(body.post_time || body.postedAt || '') || Number(body.timestamp) || null;
      const r = await supaRpc('kiwi_pay_notif_ingest', {
        p_hash: notifHash(body, p), p_method: p.incoming ? p.method : null, p_app: p.app, p_title: p.title, p_body: p.text,
        p_amount: p.incoming ? p.amount : null, p_currency: p.currency, p_sender: p.sender, p_op: p.op,
        p_posted: posted ? new Date(posted).toISOString() : null });
      return send(res, 200, { ok: true, status: r.status || (r.duplicate ? 'duplicate' : 'ok'), id: r.id || null });
    }

    if (req.method !== 'POST') return send(res, 405, { error: 'Usá POST' });
    const token = clean(body.token, 200);
    if (!token) return send(res, 401, { error: 'Iniciá sesión primero.' });

    if (action === 'create') {
      const method = String(body.method || '');
      const cfg = publicConfig();
      if (!cfg.methods.find(m => m.id === method)) return send(res, 400, { error: 'Método no disponible.' });
      const usdt = Math.round(Number(body.usdt) * 100) / 100;
      if (!(usdt >= cfg.min_usdt) || usdt > cfg.max_usdt) return send(res, 400, { error: 'El monto debe estar entre ' + cfg.min_usdt + ' y ' + cfg.max_usdt + ' USDT.' });
      const cur = METHODS[method].currency;
      const rate = await getRate(cur);
      if (!rate) return send(res, 503, { error: 'No pudimos obtener la cotización. Probá en un minuto.' });
      const qv = quote(method, usdt, rate);
      const r = await supaRpc('kiwi_pay_create', { p_token: token, p_method: method, p_usdt: usdt, p_currency: cur, p_base: qv.base,
        p_rate: rate, p_commission: qv.commission, p_step: qv.step, p_minutes: cfg.minutes, p_max_open: Number(env('PAY_MAX_OPEN', '2')) || 2 });
      return send(res, 200, { ok: true, topup: r.topup, account: cfg.methods.find(m => m.id === method).account });
    }
    if (action === 'confirm') {
      let proof = typeof body.proof === 'string' && /^data:image\/(png|jpe?g|webp);base64,/.test(body.proof) ? body.proof : null;
      if (proof && proof.length > 700000) proof = null;
      const r = await supaRpc('kiwi_pay_submit', { p_token: token, p_id: Number(body.id), p_reference: clean(body.reference, 120),
        p_payer_name: clean(body.payer_name, 80), p_proof: proof });
      let t = r.topup;
      if (t && METHODS[t.method] && METHODS[t.method].kind !== 'notif') t = await verifyTopup(t);
      return send(res, 200, { ok: true, topup: t });
    }
    if (action === 'check') {
      let t = await supaRpc('kiwi_pay_get', { p_token: token, p_id: Number(body.id) });
      const last = t.last_check_at ? Date.parse(t.last_check_at) : 0;
      if (t.status === 'submitted' && METHODS[t.method].kind !== 'notif' && Date.now() - last > 15000) t = await verifyTopup(t);
      return send(res, 200, { ok: true, topup: t });
    }
    return send(res, 400, { error: 'Acción desconocida' });
  } catch (e) {
    return send(res, 400, { error: clean(e && e.message, 300) || 'Error' });
  }
}

module.exports = handler;
module.exports._t = { parseNotification, parseAmountStr, binanceSign, quote, judge, notifHash, publicConfig, checkTronGrid,
  checkBinanceDeposit, checkBinancePay, verifyTopup, safeEq, setFetch: f => { _fetch = f; } };

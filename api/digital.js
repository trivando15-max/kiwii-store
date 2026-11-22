

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

    if (action === 'products') {
      const { ok, data } = await api('/products');
      if (!ok) {
        return res.status(502).json({ success: false, error: 'Catálogo temporalmente no disponible.' });
      }
      return res.status(200).json({success:true, currency:/^(EUR|USD|USDT)$/.test(data.currency) ? data.currency : 'EUR', products:(Array.isArray(data.products)?data.products:[]).map(p=>({id:p.id,price:p.price,stock:p.stock,variants:(Array.isArray(p.variants)?p.variants:[]).map(v=>({id:v.id,price:v.price,stock:v.stock}))}))});
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

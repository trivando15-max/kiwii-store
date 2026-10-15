/**
 * Vercel Serverless — Proxy ResellMe API
 *
 * POST /api/resellme
 *
 * Env: RESELLME_API_KEY = sk_live_...
 *
 * Body:
 *   { "action": "order", "product_id": "...", "variant_id": "...", "quantity": 1 }
 *   { "action": "products" }
 *   { "action": "balance" }
 *   { "action": "order_status", "order_id": "ord_..." }
 */

const BASE = 'https://resellme.xyz/api/reseller/v1';

function getKey() {
  const key = process.env.RESELLME_API_KEY;
  if (!key) throw new Error('Falta RESELLME_API_KEY en Vercel');
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
  return { ok: res.ok, status: res.status, data };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
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
    // --- ORDER (compra + entrega keys) ---
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
        const errMsg =
          data?.error ||
          data?.message ||
          (status === 402
            ? 'Saldo insuficiente en la cuenta del proveedor'
            : status === 409
              ? 'Sin stock disponible'
              : 'HTTP ' + status);
        return res.status(ok ? 200 : status === 402 || status === 409 ? 200 : 502).json({
          success: false,
          error: errMsg,
          detail: data
        });
      }

      // Extraer keys de la respuesta
      const keys = [];
      if (Array.isArray(data?.items)) {
        for (const it of data.items) {
          if (Array.isArray(it.keys)) keys.push(...it.keys);
          else if (it.keys) keys.push(String(it.keys));
        }
      }
      if (Array.isArray(data?.keys)) keys.push(...data.keys);
      if (data?.account) keys.push(String(data.account));

      return res.status(200).json({
        success: true,
        order_id: data.order_id || data.id || null,
        status: data.status || 'completed',
        keys,
        total: data.total,
        balance: data.balance,
        raw: data
      });
    }

    // --- PRODUCTS ---
    if (action === 'products') {
      const { ok, data } = await api('/products');
      if (!ok) {
        return res.status(502).json({ success: false, error: data?.error || 'Error catálogo' });
      }
      return res.status(200).json(data);
    }

    // --- BALANCE ---
    if (action === 'balance') {
      const { ok, data } = await api('/balance');
      if (!ok) {
        return res.status(502).json({ success: false, error: data?.error || 'Error saldo' });
      }
      return res.status(200).json(data);
    }

    // --- ORDER STATUS ---
    if (action === 'order_status' || action === 'status') {
      const orderId = body.order_id || body.orderId || body.order;
      if (!orderId) {
        return res.status(400).json({ error: 'order_id requerido' });
      }
      const { ok, data } = await api('/orders/' + encodeURIComponent(orderId));
      if (!ok) {
        return res.status(502).json({ success: false, error: data?.error || 'Error consulta' });
      }
      return res.status(200).json(data);
    }

    return res.status(400).json({
      error: 'action inválida. Usá: order | products | balance | order_status'
    });
  } catch (err) {
    console.error('[resellme proxy]', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Error interno del proxy'
    });
  }
};

/**
 * Vercel Serverless Function — Proxy para Bulk Medya API
 *
 * Ruta: POST /api/bulkmedya
 *
 * Variables de entorno requeridas en Vercel:
 *   BULK_MEDYA_API_KEY = f07776f87a5974953972921dba729e92
 *
 * Body JSON esperado:
 *   { "action": "add", "service": 15217, "link": "https://instagram.com/...", "quantity": 1000 }
 *   { "action": "status", "order": 23501 }
 *   { "action": "balance" }
 *   { "action": "services" }
 */

const BULK_API_URL = 'https://bulkmedya.org/api/v2';

function getApiKey() {
  const key = process.env.BULK_MEDYA_API_KEY;
  if (!key) {
    throw new Error('Falta la variable de entorno BULK_MEDYA_API_KEY en Vercel');
  }
  return key;
}

async function callBulkMedya(params) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) body.set(k, String(v));
  }

  const res = await fetch(BULK_API_URL, {
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

module.exports = async function handler(req, res) {
  // CORS básico (misma origen en producción)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  let payload = req.body;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }
  }
  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'Missing body' });
  }

  const action = String(payload.action || '').toLowerCase();

  try {
    const apiKey = getApiKey();

    // --- ADD ORDER ---
    if (action === 'add') {
      const service = Number(payload.service);
      const link = String(payload.link || '').trim();
      const quantity = Number(payload.quantity);

      if (!service || !Number.isFinite(service)) {
        return res.status(400).json({ error: 'service (número) es obligatorio' });
      }
      if (!link) {
        return res.status(400).json({ error: 'link es obligatorio' });
      }
      if (!quantity || quantity < 1) {
        return res.status(400).json({ error: 'quantity debe ser >= 1' });
      }

      const { ok, data } = await callBulkMedya({
        key: apiKey,
        action: 'add',
        service,
        link,
        quantity
      });

      if (data && data.order) {
        return res.status(200).json({
          success: true,
          order: data.order,
          orderId: data.order
        });
      }

      return res.status(ok ? 200 : 502).json({
        success: false,
        error: data?.error || data?.message || data?.raw || 'Bulk Medya no devolvió order ID',
        detail: data
      });
    }

    // --- ORDER STATUS ---
    if (action === 'status') {
      const order = payload.order;
      if (!order) {
        return res.status(400).json({ error: 'order es obligatorio' });
      }

      const { data } = await callBulkMedya({
        key: apiKey,
        action: 'status',
        order
      });

      return res.status(200).json(data);
    }

    // --- BALANCE ---
    if (action === 'balance') {
      const { data } = await callBulkMedya({
        key: apiKey,
        action: 'balance'
      });
      return res.status(200).json(data);
    }

    // --- SERVICES LIST ---
    if (action === 'services') {
      const { data } = await callBulkMedya({
        key: apiKey,
        action: 'services'
      });
      return res.status(200).json(data);
    }

    return res.status(400).json({
      error: 'action inválida. Usá: add | status | balance | services'
    });
  } catch (err) {
    console.error('[bulkmedya proxy]', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Error interno del proxy'
    });
  }
};

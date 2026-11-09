

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

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
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

      const { ok, data } = await callDelivery({
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
        error: 'No pudimos completar la entrega. Consultá a soporte.'
      });
    }

    if (action === 'status') {
      const order = payload.order;
      if (!order) {
        return res.status(400).json({ error: 'order es obligatorio' });
      }

      const { data } = await callDelivery({
        key: apiKey,
        action: 'status',
        order
      });

      if (data?.error || data?.raw) return res.status(502).json({success:false,error:'Consulta temporalmente no disponible.'});
      return res.status(200).json({status:data.status,remains:data.remains,start_count:data.start_count});
    }

    // v79: saldo y catálogo con costos SOLO con el secreto de admin (header x-pay-secret = PAY_NOTIF_SECRET).
    // Antes respondían a cualquiera y mostraban los costos públicamente.
    if (action === 'balance' || action === 'services') {
      const secret = String(process.env.PAY_NOTIF_SECRET || '');
      const given = String((req.headers && (req.headers['x-pay-secret'] || req.headers['x-admin-secret'])) || '');
      const a = Buffer.from(given), b = Buffer.from(secret);
      if (secret.length < 16 || a.length !== b.length || !require('crypto').timingSafeEqual(a, b)) {
        return res.status(401).json({ success: false, error: 'no autorizado' });
      }
    }

    if (action === 'balance') {
      const { data } = await callDelivery({
        key: apiKey,
        action: 'balance'
      });
      if (data?.error || data?.raw) return res.status(502).json({success:false,error:'Consulta temporalmente no disponible.'});
      return res.status(200).json({balance:data.balance,currency:data.currency});
    }

    if (action === 'services') {
      const { data } = await callDelivery({
        key: apiKey,
        action: 'services'
      });
      if (!Array.isArray(data)) return res.status(502).json({success:false,error:'Catálogo temporalmente no disponible.'});
      return res.status(200).json(data.map(s=>({service:s.service,type:s.type,rate:s.rate,min:s.min,max:s.max})));
    }

    return res.status(400).json({
      error: 'action inválida. Usá: add | status | balance | services'
    });
  } catch (err) {

    return res.status(500).json({
      success: false,
      error: 'Servicio temporalmente no disponible.'
    });
  }
};

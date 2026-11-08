module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  res.setHeader('Cache-Control', 'no-store');
  const apiKey = process.env.RECARGAS_API_KEY || process.env.RA_API_KEY || process.env.RECARGAS_AMERICA_API_KEY || process.env.RECARGAS_API_TOKEN;
  const base = (process.env.INSTANT_API_BASE || process.env.RA_API_BASE || 'https://panel.recargasamerica.com/api/v1').replace(/\/+$/, '');
  if (!apiKey) {
    return res.status(500).json({ success: false, error: 'Servicio temporalmente no disponible.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }
  body = body || {};

  const rawProduct = body.product_id ?? body.producto ?? body.productId;
  const rawPlayer =
    body.player_id ?? body.playerId ?? body.destination ?? body.uid ?? body.user_id;
  const rawQty = body.quantity ?? body.qty ?? 1;

  const productId = Number(rawProduct);
  const playerId = String(rawPlayer || '').trim();
  const quantity = Number(rawQty) || 1;

  if (!Number.isFinite(productId) || productId <= 0) {
    return res.status(400).json({
      success: false,
      error: 'Missing or invalid product_id',
      code: 'MISSING_FIELD'
    });
  }
  if (!playerId) {
    return res.status(400).json({
      success: false,
      error: 'Missing player_id',
      code: 'MISSING_FIELD'
    });
  }

  const upstreamBody = {
    product_id: productId,
    producto: productId,
    player_id: playerId,
    destination: playerId,
    quantity: quantity,
    client_name: 'KiwiiStore'
  };

  try {
    const response = await fetch(base + '/buy/catalog', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(upstreamBody)
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = { raw: text };
    }

    if (response.ok && (data.success === true || data.status === true || data.status === 'OK' || data.ok === true)) {
      return res.status(200).json({ success: true });
    }

    return res.status(response.ok ? 200 : 502).json({ success: false, error: 'No pudimos completar la entrega. Consultá a soporte con tu número de pedido.' });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'No pudimos confirmar la entrega. Consultá a soporte antes de reintentar.'
    });
  }
}

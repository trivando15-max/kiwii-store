// Vercel Serverless Function - Proxy for RecargasAmerica
// Variables de entorno en Vercel: RECARGAS_API_KEY
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.RECARGAS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ success: false, error: 'API key not configured (RECARGAS_API_KEY)' });
  }

  // Body puede venir como objeto o string según el runtime
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

  // Payload compatible con RecargasAmerica:
  // - producto / product_id como ENTERO
  // - player_id (no solo "destination")
  const upstreamBody = {
    product_id: productId,
    producto: productId,
    player_id: playerId,
    destination: playerId,
    quantity: quantity,
    client_name: 'KiwiiStore'
  };

  try {
    const response = await fetch('https://panel.recargasamerica.com/api/v1/buy/catalog', {
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

    // Normalizar respuesta para el frontend
    if (response.ok && (data.success === true || data.status === true || data.status === 'OK' || data.ok === true)) {
      return res.status(200).json({ success: true, ...data });
    }

    return res.status(response.status).json({
      success: false,
      error: data.error || data.message || data.msg || ('HTTP ' + response.status),
      code: data.code || undefined,
      errors: data.errors || undefined,
      upstream: data
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'Proxy error',
      message: err.message
    });
  }
}

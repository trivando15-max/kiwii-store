// Vercel Serverless Function - Proxy for RecargasAmerica
// Set RECARGAS_API_KEY in Vercel environment variables

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.RECARGAS_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const { product_id, player_id, quantity = 1 } = req.body || {};
  if (!product_id || !player_id) {
    return res.status(400).json({ error: 'Missing product_id or player_id' });
  }

  try {
    const response = await fetch('https://panel.recargasamerica.com/api/v1/buy/catalog', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        product_id: product_id,
        destination: player_id,
        quantity: quantity,
        client_name: 'KiwiiStore'
      })
    });
    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: 'Proxy error', message: err.message });
  }
}

// Vercel Serverless Function - Proxy for Volsever Free Fire API
// Deploy this and set VOLSEVER_API_KEY in Vercel environment variables

export default async function handler(req, res) {
  // Allow CORS from any origin (or restrict to your domain)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action, id, region } = req.query;
  const apiKey = process.env.VOLSEVER_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  let url;
  if (action === 'check-products') {
    url = `https://gate.volsever.com/garena/api/v1/pagostore/free-fire/check-products?id=${encodeURIComponent(id)}&region=${encodeURIComponent(region || 'BO')}`;
  } else if (action === 'check-discounts') {
    url = `https://gate.volsever.com/garena/api/v1/pagostore/free-fire/check-discounts-paypal-dom?id=${encodeURIComponent(id)}`;
  } else {
    return res.status(400).json({ error: 'Invalid action' });
  }

  try {
    const response = await fetch(url, {
      headers: {
        'X-API-KEY': apiKey
      }
    });
    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: 'Proxy error', message: err.message });
  }
}

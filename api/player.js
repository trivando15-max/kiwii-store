
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action, id, region } = req.query || {};
  const apiKey = process.env.VOLSEVER_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'Servicio temporalmente no disponible.' });
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
    if (!response.ok || data?.error) return res.status(502).json({status:false,error:'No pudimos verificar el jugador.',message:'Intentá nuevamente más tarde.'});
    const d = data.data || {};
    return res.status(200).json({status:!!data.status,data:{username:d.username,nickname:d.nickname,account_region:d.account_region,region:d.region,user_id:d.user_id,uid:d.uid,discount_items:Array.isArray(d.discount_items)?d.discount_items.map(x=>({diamonds:x.diamonds,is_discount:x.is_discount})):undefined},message:data.status?undefined:'No encontramos ese jugador.'});
  } catch (err) {
    return res.status(500).json({ status: false, error: 'No pudimos verificar el jugador.', message: 'Intentá nuevamente más tarde.' });
  }
}

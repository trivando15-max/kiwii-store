export default async function handler(req, res) {
  const fiat = (req.query.fiat || 'ARS').toUpperCase();
  try {
    const r = await fetch('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0'
      },
      body: JSON.stringify({
        asset: 'USDT',
        fiat,
        tradeType: 'BUY',
        page: 1,
        rows: 20
      })
    });
    const data = await r.json();
    const prices = (data.data || []).map(a => parseFloat(a.adv.price)).filter(p => p > 0);
    if (prices.length === 0) return res.status(200).json({ fiat, rate: null, note: 'sin ofertas' });
    prices.sort((a, b) => a - b);
    const mid = prices[Math.floor(prices.length / 2)];
    return res.status(200).json({ fiat, rate: mid });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// /api/binance-p2p?fiat=COP  →  { fiat, rate, prices, payTypes, transAmount, source }
// Precio de COMPRA de USDT en Binance P2P (lo que paga un cliente que compra USDT),
// filtrado por el método de pago más usado en cada país y por un monto chico (~10 USDT),
// promediando los 5 mejores anuncios. El margen extra ("Al instante") se aplica en el HTML (KIWI_RATE_MARGIN).

const CONFIG = {
  ARS: { payTypes: [],                transAmount: 16500 },
  MXN: { payTypes: ['BBVABank'],      transAmount: 190 },
  COP: { payTypes: ['BancolombiaSA'], transAmount: 32000 },
  PEN: { payTypes: ['Yape'],          transAmount: 35 },
};
const TOP_N = 5;
const URL = 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';

async function search(fiat, payTypes, transAmount) {
  const body = {
    fiat, asset: 'USDT', tradeType: 'BUY', page: 1, rows: 10,
    payTypes, publisherType: null,
  };
  if (transAmount) body.transAmount = transAmount;
  const r = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('Binance HTTP ' + r.status);
  const j = await r.json();
  return (j.data || []).map(a => Number(a.adv && a.adv.price)).filter(n => Number.isFinite(n) && n > 0);
}

async function handler(req, res) {
  const fiat = String((req.query && req.query.fiat) || 'ARS').toUpperCase();
  const cfg = CONFIG[fiat];
  if (!cfg) return res.status(400).json({ error: 'fiat no soportado' });
  // Intentos: método de pago + monto → solo monto → sin filtros
  const attempts = [
    [cfg.payTypes, cfg.transAmount, 'payType+amount'],
    [[], cfg.transAmount, 'amount'],
    [[], null, 'any'],
  ];
  for (const [pt, amt, source] of attempts) {
    try {
      const prices = (await search(fiat, pt, amt)).sort((a, b) => a - b).slice(0, TOP_N);
      if (prices.length) {
        const avg = prices.reduce((s, p) => s + p, 0) / prices.length;
        const rate = Math.round(avg * 1000) / 1000;
        res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
        return res.status(200).json({ fiat, rate, prices, payTypes: pt, transAmount: amt, source });
      }
    } catch (e) { /* probar el siguiente */ }
  }
  return res.status(502).json({ error: 'Binance P2P no respondió' });
}

module.exports = handler;

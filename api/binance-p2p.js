// /api/binance-p2p?fiat=COP  →  { fiat, rate, prices, payTypes, transAmount, source }
// Precio de COMPRA de USDT en Binance P2P (lo que paga un cliente que compra USDT),
// v75: mejor anuncio BUY (menor precio), sin filtro de banco/método de pago,
// para un monto chico (~10 USDT), con respaldo sin monto si no hay anuncios.
// Devuelve la tasa base sin margen; el +1,6% se aplica en HTML (KIWI_RATE_MARGIN) y pay.js (RATE_MARGIN).

const CONFIG = {
  ARS: { payTypes: [], transAmount: 16500 },
  MXN: { payTypes: [], transAmount: 190 },
  COP: { payTypes: [], transAmount: 32000 },
  PEN: { payTypes: [], transAmount: 35 },
  CLP: { payTypes: [], transAmount: 9800 },   // v78: Chile (~10 USDT)
  CRC: { payTypes: [], transAmount: 4500 },   // v78: Costa Rica (~10 USDT)
  UYU: { payTypes: [], transAmount: 430 },    // v79: Uruguay (~10 USDT, solo para mostrar precios)
};
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
  // Intentos compatibles: configuración sin banco + monto → solo monto → sin filtros
  const attempts = [
    [cfg.payTypes, cfg.transAmount, 'payType+amount'],
    [[], cfg.transAmount, 'amount'],
    [[], null, 'any'],
  ];
  for (const [pt, amt, source] of attempts) {
    try {
      const prices = (await search(fiat, pt, amt)).sort((a, b) => a - b);
      if (prices.length) {
        const rate = prices[0];
        res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
        return res.status(200).json({ fiat, rate, prices, payTypes: pt, transAmount: amt, source });
      }
    } catch (e) { /* probar el siguiente */ }
  }
  return res.status(502).json({ error: 'Binance P2P no respondió' });
}

module.exports = handler;

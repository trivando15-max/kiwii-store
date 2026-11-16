// v83: desactivado. Las compras de diamantes pasan por /api/game (cobro y entrega en el servidor).
// Se puede borrar este archivo del repo cuando quieras (deja una función menos en Vercel).
module.exports = function handler(req, res) {
  res.statusCode = 410;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ success: false, error: 'Actualizá la página para comprar.' }));
};

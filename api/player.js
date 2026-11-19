// v87: verificación de ID de Free Fire (compatibilidad con páginas viejas en caché).
// Ya NO usa ningún servicio externo de terceros: verifica con el mismo sistema que /api/game (con caché y límites por IP).
// La web nueva llama directo a /api/game (action "validate"). Este archivo se puede borrar más adelante.
const lib = require('./_game-lib');
const FF_KEY = 5;   // 110 Diamantes Free Fire LATAM (se usa solo para verificar el ID)

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(obj));
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return send(res, 200, {});
  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
  const q = req.query || {};
  const action = String(q.action || ''), id = String(q.id || '').replace(/\s+/g, '');
  if (action === 'check-discounts') return send(res, 200, { status: false, data: null, message: 'No disponible.' });
  if (action !== 'check-products') return send(res, 400, { error: 'Invalid action' });
  if (!/^\d{5,15}$/.test(id)) return send(res, 200, { status: false, message: 'ID inválido.' });
  if (!lib.provReady()) return send(res, 500, { status: false, error: 'Servicio temporalmente no disponible.' });
  try {
    const live = await lib.getCosts();
    const it = live.items && live.items[FF_KEY];
    if (!it) return send(res, 200, { status: true, data: { uid: id, user_id: id, nickname: null, unverified: true } });
    const t = lib.buildTarget(it.fields, (live.schemas || {})[FF_KEY], id, '');
    if (t.error) return send(res, 200, { status: false, message: 'ID inválido.' });
    const v = await lib.verifyPlayer(it.ref, t.payload, lib.clientIp(req.headers));
    if (v.status === 'invalid') return send(res, 200, { status: false, message: 'No encontramos ese jugador.' });
    return send(res, 200, { status: true, data: { uid: id, user_id: id, nickname: v.name || null, username: v.name || null, unverified: v.status !== 'valid' } });
  } catch (_) {
    return send(res, 200, { status: false, error: 'No pudimos verificar el jugador.', message: 'Intentá nuevamente más tarde.' });
  }
};

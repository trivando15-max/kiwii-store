// v94: estado de los pedidos automáticos de Redes (seguidores / likes / vistas) y Streaming / apps.
// Consulta al servicio que hizo la entrega y, cuando confirma que terminó, marca el pedido "Completado" en Supabase.
// La invitación a dejar reseña en Discord la genera la base (kiwii-v94.sql) UNA sola vez por pedido al pasar a Completado.
// Acá NO van nombres, URLs ni claves de los servicios (el repo es público): las consultas viven en social.js / digital.js.
const lib = require('./_game-lib');
const env = k => String(process.env[k] || '').trim();
const DISCORD_LINK = 'https://discord.gg/BCKR9B8kkD';

let social = null, digital = null;
const mod = (n) => { try { return require(n); } catch (_) { return null; } };
function srcOf(ref) {
  const r = String(ref == null ? '' : ref).trim();
  if (/^D:/.test(r)) {   // streaming: solo referencias firmadas por el servidor (nadie puede pedir los datos de un pedido ajeno)
    digital = digital || mod('./digital');
    const id = digital && digital.verifyRef ? digital.verifyRef(r) : null;
    return id ? { src: 'digital', id } : null;
  }
  if (/^\d{1,20}$/.test(r)) return { src: 'social', id: r };
  return null;
}
// Redes: estados típicos Pending / In progress / Processing / Completed / Partial / Canceled (+ remains)
function classifySocial(st, remains, title) {
  const s = String(st || '').toLowerCase().trim(); const rem = Number(remains);
  if (s === 'completed' || s === 'complete') return { result: 'delivered' };
  if (s === 'partial') {
    if (Number.isFinite(rem) && rem <= 0) return { result: 'delivered' };
    return { result: 'problem', note: 'La entrega quedó incompleta' + (Number.isFinite(rem) ? ' (faltaron ' + rem + ')' : '') + '. El staff lo revisa y te devuelve el saldo de lo que falta.', staff: 'Entrega parcial' + (Number.isFinite(rem) ? ': faltan ' + rem : '') + '. Devolvé la parte que falta desde el panel (Cancelar con reembolso parcial).' };
  }
  if (s === 'canceled' || s === 'cancelled' || s === 'refunded' || s === 'fail' || s === 'failed')
    return { result: 'problem', note: 'El servicio no pudo completar la entrega. El staff lo revisa y te devuelve el saldo.', staff: 'Cancelado por el servicio (' + s + '). El cliente pagó: cancelalo con reembolso desde el panel o volvé a cargarlo.' };
  return { result: 'processing' };
}
// Streaming / apps: completed / delivered = listo; failed / cancelled / refunded = problema; el resto sigue en proceso
function classifyDigital(st, keys) {
  const s = String(st || '').toLowerCase().trim();
  if (/^(completed?|delivered|fulfilled|success|done|paid_delivered)$/.test(s)) return { result: 'delivered', keys: keys || [] };
  if (/^(failed|fail|cancel+ed|refunded?|rejected|error|expired)$/.test(s))
    return { result: 'problem', note: 'El servicio no pudo entregar este producto. El staff lo revisa y te devuelve el saldo.', staff: 'Falló en el servicio (' + s + '). El cliente pagó: cancelalo con reembolso desde el panel.' };
  return { result: 'processing' };
}

async function checkOne(row) {
  const ref = srcOf(row.ref); if (!ref) return null;
  let c;
  if (ref.src === 'social') {
    social = social || mod('./social'); if (!social || !social.statusOf) return null;
    const r = await social.statusOf(ref.id);
    if (!r.ok) return { remote: r.error ? 'error' : 'sin respuesta', result: 'processing' };
    c = classifySocial(r.status, r.remains, row.title); c.remote = r.status;
  } else {
    digital = digital || mod('./digital'); if (!digital || !digital.statusOf) return null;
    const r = await digital.statusOf(ref.id);
    if (!r.ok) return { remote: 'sin respuesta', result: 'processing' };
    c = classifyDigital(r.status, r.keys); c.remote = r.status;
  }
  return c;
}
async function syncRow(row) {
  const c = await checkOne(row);
  if (!c) {   // sin referencia válida o sin clave del servicio: se espacia la próxima revisión y listo
    await lib.sbSoft('kiwi_auto_mark', { p_order_id: String(row.id), p_result: 'processing', p_remote: 'sin consulta' });
    return { id: String(row.id), status: 'processing' };
  }
  const extra = c.result === 'delivered' && Array.isArray(c.keys) && c.keys.length ? c.keys.join('\n').slice(0, 3800) : null;
  const m = await lib.sb('kiwi_auto_mark', { p_order_id: String(row.id), p_result: c.result, p_remote: String(c.remote || '').slice(0, 60), p_note: c.note || null, p_extra: extra });
  if (m && m.changed && c.result === 'problem') {
    await lib.tg('⚠️ <b>Pedido automático con problema</b>\n#' + lib.tgEsc(row.id) + ' · ' + lib.tgEsc(row.title || '') + ' · ' + lib.tgEsc(row.user_name || '') + '\n' + lib.tgEsc(c.staff || '')).catch(() => {});
  }
  return { id: String(row.id), status: m && m.status ? publicOf(m.status) : (c.result === 'delivered' ? 'delivered' : 'processing') };
}
const publicOf = s => (s === 'delivered' || s === 'accredited') ? 'delivered' : s === 'problem' ? 'problem' : s === 'cancelled' ? 'cancelled' : 'processing';

// Revisa pedidos pendientes. token = solo los del cliente; sin token = los que tocan (cron / tick). Corta a los ~budgetMs.
async function syncDue(opts) {
  opts = opts || {};
  const t0 = Date.now(), budget = opts.budgetMs || 7000;
  const rows = await lib.sb('kiwi_auto_due', Object.assign({ p_limit: opts.limit || 5 }, opts.token ? { p_token: opts.token } : {}));
  const out = [];
  for (const row of (Array.isArray(rows) ? rows : [])) {
    if (Date.now() - t0 > budget) break;
    try { out.push(await syncRow(row)); } catch (e) { out.push({ id: String(row.id), status: 'processing' }); }
  }
  return out;
}

// Opcional: además del aviso en la web, publicar la invitación en un canal de Discord (DISCORD_BOT_TOKEN + DISCORD_REVIEW_INVITE_CHANNEL_ID).
// Discord no deja escribirle por privado a alguien sin conocer su cuenta de Discord, por eso es un canal.
async function postReviewInvites(limit) {
  const token = env('DISCORD_BOT_TOKEN'), ch = env('DISCORD_REVIEW_INVITE_CHANNEL_ID');
  if (!token || !/^\d{5,25}$/.test(ch)) return 0;
  const list = await lib.sbSoft('kiwi_review_discord_claim', { p_limit: limit || 5 });
  let n = 0;
  for (const it of (Array.isArray(list) ? list : [])) {
    const user = String(it.username || '').replace(/[`*_~|<>@]/g, '').slice(0, 40);
    const title = String(it.title || 'tu pedido').replace(/[`*_~|<>@]/g, '').slice(0, 90);
    const rc = env('DISCORD_REVIEWS_CHANNEL_ID');
    const content = '✅ **' + user + '**, tu pedido **' + title + '** ya está completado en Kiwii Store.\n¿Qué tal te fue? Dejanos tu reseña' + (/^\d{5,25}$/.test(rc) ? ' en <#' + rc + '>' : '') + ' ⭐';
    const body = { content, allowed_mentions: { parse: [] } };
    try {
      const r = await fetch('https://discord.com/api/v10/channels/' + ch + '/messages', { method: 'POST', headers: { Authorization: 'Bot ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (r.ok) n++;
    } catch (_) {}
  }
  return n;
}

module.exports = { syncDue, syncRow, srcOf, classifySocial, classifyDigital, postReviewInvites, publicOf, DISCORD_LINK };

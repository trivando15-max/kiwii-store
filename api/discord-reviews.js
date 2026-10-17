export default async function handler(req, res) {
  const token = process.env.DISCORD_BOT_TOKEN;
  const channelId = '1510089106187616266';
  if (!token) return res.status(500).json({ error: 'Falta DISCORD_BOT_TOKEN en Vercel' });

  try {
    const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=15`, {
      headers: { Authorization: `Bot ${token}` }
    });
    if (!r.ok) {
      const txt = await r.text();
      return res.status(r.status).json({ error: 'Discord error', status: r.status, detail: txt.slice(0, 200) });
    }
    const messages = await r.json();
    const reviews = messages.map(m => {
      let image = null;
      if (m.attachments && m.attachments[0]) image = m.attachments[0].url;
      else if (m.embeds && m.embeds[0] && m.embeds[0].image) image = m.embeds[0].image.url;
      return {
        author: m.author.username,
        avatar: m.author.avatar ? `https://cdn.discordapp.com/avatars/${m.author.id}/${m.author.avatar}.png` : null,
        content: m.content,
        image,
        timestamp: m.timestamp
      };
    });
    res.setHeader('Cache-Control', 's-maxage=30');
    return res.status(200).json({ reviews });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

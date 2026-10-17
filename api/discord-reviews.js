export default async function handler(req, res) {
  const token = process.env.DISCORD_BOT_TOKEN;
  const channelId = '1510089106187616266';
  if (!token) return res.status(500).json({ error: 'Falta DISCORD_BOT_TOKEN' });

  try {
    const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=15`, {
      headers: { Authorization: `Bot ${token}` }
    });
    if (!r.ok) return res.status(r.status).json({ error: 'Discord error', status: r.status });
    const messages = await r.json();
    const reviews = messages.map(m => ({
      author: m.author.username,
      avatar: m.author.avatar
        ? `https://cdn.discordapp.com/avatars/${m.author.id}/${m.author.avatar}.png`
        : null,
      content: m.content,
      image: m.attachments && m.attachments[0] ? m.attachments[0].url : null,
      timestamp: m.timestamp
    }));
    res.setHeader('Cache-Control', 's-maxage=60');
    return res.status(200).json({ reviews });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

import { read, write } from './_store.js';

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  try {
    if (req.method === 'GET') return res.status(200).json(await read());
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (JSON.stringify(b).length > 400000) return res.status(413).json({ error: 'Too large' });
    const d = await read();
    switch (b.op) {
      case 'addVersion':
        if (!b.v || !b.v.id) return res.status(400).json({ error: 'Missing version' });
        d.versions = d.versions.filter(v => v.id !== b.v.id); d.versions.push(b.v); break;
      case 'delVersion': d.versions = d.versions.filter(v => v.id !== b.id); break;
      case 'upsertItem': {
        if (!b.item || !b.item.id) return res.status(400).json({ error: 'Missing item' });
        const i = d.items.findIndex(x => x.id === b.item.id);
        if (i >= 0) d.items[i] = b.item; else d.items.push(b.item); break;
      }
      case 'delItem': d.items = d.items.filter(x => x.id !== b.id); break;
      case 'delRender': d.renders = d.renders.filter(x => x.id !== b.id); break;
      default: return res.status(400).json({ error: 'Unknown op' });
    }
    await write(d);
    return res.status(200).json(d);
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}

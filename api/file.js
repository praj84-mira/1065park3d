import { get } from '@vercel/blob';

export default async function handler(req, res) {
  const p = String(req.query.p || '');
  if (!/^lr13ab\/files\/[a-z0-9]+\.(jpg|png|webp|gif|pdf)$/.test(p)) return res.status(400).end();
  const r = await get(p, { access: 'private' }).catch(() => null);
  if (!r || r.statusCode !== 200 || !r.stream) return res.status(404).end();
  const buf = Buffer.from(await new Response(r.stream).arrayBuffer());
  res.setHeader('content-type', r.blob.contentType || 'application/octet-stream');
  res.setHeader('content-disposition', 'inline');
  res.setHeader('cache-control', 'private, max-age=31536000, immutable');
  return res.status(200).send(buf);
}

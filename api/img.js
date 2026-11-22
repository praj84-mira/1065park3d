import { UA, safeUrl } from './_net.js';

export default async function handler(req, res) {
  const url = safeUrl(req.query.u);
  if (!url) return res.status(400).end();
  let r;
  try { r = await fetch(url, { headers: { 'user-agent': UA, accept: 'image/avif,image/webp,image/*,*/*;q=0.8', referer: url.origin + '/' }, redirect: 'follow', signal: AbortSignal.timeout(10000) }); }
  catch { return res.status(502).end(); }
  if (!r.ok) return res.status(502).end();
  const ct = r.headers.get('content-type') || '';
  if (!ct.startsWith('image/')) return res.status(415).end();
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 12e6) return res.status(413).end();
  res.setHeader('content-type', ct);
  res.setHeader('cache-control', 'public, max-age=86400, s-maxage=604800');
  return res.status(200).send(buf);
}

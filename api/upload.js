import { put } from '@vercel/blob';

const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf' };
const MAX = 4.4e6; // Vercel request bodies top out around 4.5 MB

async function readBody(req) {
  try { const b = req.body; if (Buffer.isBuffer(b) && b.length) return b; } catch {}
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > MAX) throw Object.assign(new Error('too-large'), { code: 413 }); chunks.push(c); }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const type = String(req.headers['x-file-type'] || '').toLowerCase();
  const ext = TYPES[type];
  if (!ext) return res.status(415).json({ error: 'Photos (JPG, PNG, WebP) and PDFs only' });
  let buf;
  try { buf = await readBody(req); } catch (e) { return res.status(e.code || 400).json({ error: e.code === 413 ? 'File is over 4 MB' : 'Could not read upload' }); }
  if (!buf || !buf.length) return res.status(400).json({ error: 'Empty file' });
  if (buf.length > MAX) return res.status(413).json({ error: 'File is over 4 MB' });
  if (ext === 'pdf' && buf.subarray(0, 4).toString() !== '%PDF') return res.status(415).json({ error: 'That doesn’t look like a PDF' });
  let name = 'file';
  try { name = decodeURIComponent(String(req.headers['x-file-name'] || 'file')).replace(/[^\w.\- ()]+/g, '').slice(0, 80) || 'file'; } catch {}
  const path = `lr13ab/files/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.${ext}`;
  try { await put(path, buf, { access: 'private', contentType: type, addRandomSuffix: false }); }
  catch (e) { return res.status(500).json({ error: String((e && e.message) || e) }); }
  return res.status(200).json({ path, name, type, size: buf.length });
}

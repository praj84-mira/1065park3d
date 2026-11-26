// Photoreal render: sends a capture of the 3D view to Replicate (google/nano-banana-pro)
// and saves the result to Blob. The Replicate token lives only in the REPLICATE_API_TOKEN env var.
import { put, get } from '@vercel/blob';
import { read, write } from './_store.js';

const MODEL = 'google/nano-banana-pro';
const DAILY_CAP = Number(process.env.RENDER_DAILY_CAP || 30); // ~$0.15 each
const MAX_IMG = 3.5e6;

const LOCK = `Turn image 1 into a photorealistic interior photograph of the same room, as if shot by an Architectural Digest photographer.
Image 1 is a 3D massing model and is the SOURCE OF TRUTH for geometry: keep the exact camera position, lens and framing; keep every wall, window, opening, the fireplace and every piece of furniture exactly where and how large they are in image 1. Do not move, add or remove openings, windows, walls or furniture.
All door openings are square-headed (flat tops), never arched. The fireplace firebox sits where image 1 shows it; there is only one fireplace.
Beyond the openings: west opening = dining area, east wide opening = kitchen, south opening = entry hall. No windows in the kitchen or dining area.
Replace flat model colors and textures with real materials matching the description below. The architecture (walls, openings, windows, fireplace position, ceiling) is fixed. Furniture keeps its position and rough size from image 1, but where the design brief describes a specific piece, style, fabric or pattern, show that exact piece instead of the simple model shape. Natural, believable light; realistic shadows and reflections; crisp detail. No people, no text, no watermark.
Room: living room of a pre-war Park Avenue apartment in New York.`;

function token() { const t = process.env.REPLICATE_API_TOKEN; if (!t) throw Object.assign(new Error('Rendering is not set up yet (missing REPLICATE_API_TOKEN).'), { code: 503 }); return t; }
async function rep(path, init = {}) {
  const r = await fetch('https://api.replicate.com/v1/' + path, { ...init, headers: { authorization: 'Bearer ' + token(), 'content-type': 'application/json', ...(init.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.detail || j.title || ('Replicate error ' + r.status)), { code: r.status === 429 ? 429 : 502 });
  return j;
}
async function bumpCount() {
  const day = new Date().toISOString().slice(0, 10), p = `lr13ab/render-count/${day}.json`;
  let n = 0;
  const r = await get(p, { access: 'private', useCache: false }).catch(() => null);
  if (r && r.statusCode === 200 && r.stream) { try { n = JSON.parse(await new Response(r.stream).text()).n || 0; } catch {} }
  if (n >= DAILY_CAP) throw Object.assign(new Error(`Daily render limit (${DAILY_CAP}) reached. Try again tomorrow.`), { code: 429 });
  await put(p, JSON.stringify({ n: n + 1 }), { access: 'private', allowOverwrite: true, addRandomSuffix: false, contentType: 'application/json' });
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  try {
    if (req.method === 'POST') {
      const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const img = String(b.image || '');
      if (!/^data:image\/(jpeg|png);base64,/.test(img)) return res.status(400).json({ error: 'Missing view capture' });
      if (img.length > MAX_IMG) return res.status(413).json({ error: 'Capture too large' });
      const desc = String(b.desc || '').slice(0, 2500);
      const brief = String(b.brief || '').slice(0, 1600);
      const refs = [];
      for (const p of (Array.isArray(b.refs) ? b.refs : []).slice(0, 6)) {
        if (!/^lr13ab\/files\/[a-z0-9]+\.(jpg|png|webp)$/.test(String(p))) continue;
        const r = await get(String(p), { access: 'private' }).catch(() => null);
        if (!r || r.statusCode !== 200 || !r.stream) continue;
        refs.push(`data:${r.blob.contentType || 'image/jpeg'};base64,` + Buffer.from(await new Response(r.stream).arrayBuffer()).toString('base64'));
      }
      const extra = String(b.extra || '').slice(0, 600);
      await bumpCount();
      const prompt = `${LOCK}\nDesign (materials and finishes from the 3D model): ${desc}${brief ? `\nDesign brief from the owner (takes precedence over the 3D model's furniture shapes, fabrics and finishes wherever they differ): ${brief}` : ''}${refs.length ? `\nImages 2-${refs.length + 1} are the owner's reference images (reference 1 = image 2, and so on). Reproduce the items, materials and patterns they show as faithfully as possible, placed where the brief says, in this room. Do not copy their room architecture or camera.` : ''}${extra ? `\nAdditional direction from the owner: ${extra}` : ''}`;
      const ar = ['4:3', '3:4', '16:9', '9:16', '1:1', '3:2', '2:3'].includes(b.ar) ? b.ar : 'match_input_image';
      const p = await rep(`models/${MODEL}/predictions`, { method: 'POST', body: JSON.stringify({ input: { prompt, image_input: [img, ...refs], resolution: '2K', output_format: 'jpg', aspect_ratio: ar } }) });
      return res.status(200).json({ id: p.id, status: p.status });
    }
    if (req.method === 'GET') {
      const id = String(req.query.id || '');
      if (!/^[a-z0-9]{10,40}$/.test(id)) return res.status(400).json({ error: 'Bad id' });
      const p = await rep('predictions/' + id);
      if (p.status === 'failed' || p.status === 'canceled') return res.status(200).json({ status: p.status, error: p.error || 'Render failed' });
      if (p.status !== 'succeeded') return res.status(200).json({ status: p.status });
      const path = `lr13ab/files/r${id}.jpg`;
      const d = await read();
      let r = d.renders.find(x => x.id === id);
      if (!r) {
        const url = Array.isArray(p.output) ? p.output[0] : p.output;
        const img = await fetch(url); if (!img.ok) throw new Error('Could not fetch render output');
        await put(path, Buffer.from(await img.arrayBuffer()), { access: 'private', contentType: 'image/jpeg', addRandomSuffix: false, allowOverwrite: true });
        const meta = (() => { try { return JSON.parse(String(req.query.meta || '{}')); } catch { return {}; } })();
        r = { id, path, at: Date.now(), view: String(meta.view || '').slice(0, 40), label: String(meta.label || '').slice(0, 80), by: String(meta.by || '').slice(0, 40) };
        d.renders.push(r); await write(d);
      }
      return res.status(200).json({ status: 'succeeded', render: r, renders: d.renders });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(e.code && e.code < 600 ? e.code : 500).json({ error: String((e && e.message) || e) });
  }
}

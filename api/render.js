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
Replace flat model colors and textures with real materials matching the description below. The architecture (walls, openings, windows, fireplace position, ceiling) is fixed.
LAYOUT IS FIXED: every piece of furniture stays exactly where its block is in image 1, at that size and orientation. Do not add, remove, move, rotate or swap furniture. Where the design spec describes a piece, render that piece in that block's place. Natural, believable light; realistic shadows and reflections; crisp detail. No people, no text, no watermark.
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
      const spec = (Array.isArray(b.spec) ? b.spec : []).slice(0, 16).map(x => ({ what: String(x.what || '').slice(0, 120), look: String(x.look || '').slice(0, 400), refPath: /^lr13ab\/files\/[a-z0-9]+\.(jpg|png|webp)$/.test(String(x.refPath || '')) ? String(x.refPath) : null })).filter(x => x.what && x.look);
      const refPaths = [...new Set(spec.map(x => x.refPath).filter(Boolean))].slice(0, 6);
      const refs = refPaths;
      await bumpCount();
      const twoPass = refs.length > 0;
      const specTxt = spec.map(x => `- ${x.what}: ${x.look}`).join('\n');
      const prompt = `${LOCK}\nRoom as modelled (finishes, and what each furniture block is): ${desc}${specTxt ? `\nDESIGN SPEC from the owner - this wins over the model's simple shapes and colours wherever they differ:\n${specTxt}` : ''}`;
      const ar = ['4:3', '3:4', '16:9', '9:16', '1:1', '3:2', '2:3'].includes(b.ar) ? b.ar : 'match_input_image';
      const p = await rep(`models/${MODEL}/predictions`, { method: 'POST', body: JSON.stringify({ input: { prompt, image_input: twoPass ? [img] : [img, ...refs], resolution: '2K', output_format: 'jpg', aspect_ratio: ar } }) });
      if (twoPass) await put(`lr13ab/jobs/${p.id}.json`, JSON.stringify({ refPaths, spec }), { access: 'private', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true });
      return res.status(200).json({ id: p.id, status: p.status });
    }
    if (req.method === 'GET') {
      const id = String(req.query.id || '');
      if (!/^[a-z0-9]{10,40}$/.test(id)) return res.status(400).json({ error: 'Bad id' });
      let p = await rep('predictions/' + id);
      if (p.status === 'failed' || p.status === 'canceled') return res.status(200).json({ status: p.status, error: p.error || 'Render failed' });
      if (p.status !== 'succeeded') return res.status(200).json({ status: p.status });
      // second pass: place the owner's reference pieces into the finished photo with a targeted edit
      const jr = await get(`lr13ab/jobs/${id}.json`, { access: 'private', useCache: false }).catch(() => null);
      if (jr && jr.statusCode === 200 && jr.stream) {
        const job = JSON.parse(await new Response(jr.stream).text());
        if (!job.stage2) {
          const refs = [];
          for (const rp of job.refPaths || []) { if (!/^lr13ab\/files\/[a-z0-9]+\.(jpg|png|webp)$/.test(String(rp))) continue; const r = await get(String(rp), { access: 'private' }).catch(() => null);
            if (r && r.statusCode === 200 && r.stream) refs.push(`data:${r.blob.contentType || 'image/jpeg'};base64,` + Buffer.from(await new Response(r.stream).arrayBuffer()).toString('base64')); }
          const first = Array.isArray(p.output) ? p.output[0] : p.output;
          const idx = new Map((job.refPaths || []).map((rp, i) => [rp, i + 2]));
          const instr = (job.spec || []).filter(x => x.refPath && idx.has(x.refPath)).map(x => `- ${x.what}: make it exactly the piece shown in image ${idx.get(x.refPath)} (${x.look}). Same position, orientation and scale as the piece it replaces in image 1.`).join('\n');
          const prompt = `Edit image 1, a photograph of a living room. Images 2-${refs.length + 1} are reference photos of specific pieces; use them only for the look of those pieces, never their room, walls, floor or camera.\nChanges:\n${instr}\nKeep image 1's camera, framing, walls, windows, openings, fireplace, floor, lighting, furniture layout and every object not listed exactly as they are. Photorealistic, seamless, correct scale and shadows. Change nothing else.`;
          const p2 = await rep(`models/${MODEL}/predictions`, { method: 'POST', body: JSON.stringify({ input: { prompt, image_input: [first, ...refs], resolution: '2K', output_format: 'jpg', aspect_ratio: 'match_input_image' } }) });
          job.stage2 = p2.id; await put(`lr13ab/jobs/${id}.json`, JSON.stringify(job), { access: 'private', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true });
          return res.status(200).json({ status: 'refining' });
        }
        const p2 = await rep('predictions/' + job.stage2);
        if (p2.status === 'failed' || p2.status === 'canceled') { /* fall back to the first-pass image */ }
        else if (p2.status !== 'succeeded') return res.status(200).json({ status: 'refining' });
        else p = p2;
      }
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

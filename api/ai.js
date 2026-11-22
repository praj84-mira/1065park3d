// Turns a description and/or reference photo into either a furniture item or a room "look".
// Auth: ANTHROPIC_API_KEY (direct) if set; otherwise Vercel AI Gateway via AI_GATEWAY_API_KEY or the deployment's OIDC token.
const KINDS = ['sofa','sectional','chair','slipper','swivel','ottoman','coffee','roundtable','side','console','bench','bookcase','lamp','plant','rug','art','other'];
const FINISHES = ['paint','limewash','molding','grasscloth','oak','walnut','trellis','stripe'];
const MARBLES = ['calacatta','bardiglio','nero','verde','travertine','limestone'];
const FABRICS = ['oatmeal','boucle','camel','sage','navy','rust','mustard','blush','charcoal'];
const TABLES = ['walnut','oak','travertine','lacquer'];
const RUGS = ['ivory','vintage','blue','jute','charcoal'];
const ABOVE = ['abstract','landscape','mirror','tv','none'];

const ROOM = 'Living room in a 1950s Upper East Side co-op: ~15x15 ft plus a window bay with a wide steel-framed window, ceiling ~8.5 ft, a fireplace with marble surround and mantel on the left wall, arched openings, herringbone wood floor planned, crown molding.';

const SYS = {
  item: `You help a couple visualise furniture in their ${ROOM}
From the user's description and/or photo, produce ONE furniture item as strict JSON, no prose:
{"name": short product-style name (max 50 chars), "kind": one of ${JSON.stringify(KINDS)}, "w": width inches, "d": depth inches, "h": height inches, "color": main visible color as #rrggbb, "notes": one or two sentences on what it is (style, material) }
For rugs, w and d are length and width in inches (e.g. 9x12 ft rug = w 144, d 108) and h 0.5. Use typical real-world dimensions when not stated. Pick the closest kind.`,
  scheme: `You are an interior designer helping a couple visualise looks for their ${ROOM}
From the user's description and/or reference photo, choose finishes as strict JSON, no prose. Only use the allowed values; colors are #rrggbb you choose freely.
{"summary": one sentence describing the look,
 "walls": {"fire": {"f": finish, "c": color}, "window": {...}, "entry": {...}, "opening": {...}},   // finish one of ${JSON.stringify(FINISHES)}; "fire" is the fireplace wall
 "floorP": "herringbone" or "plank", "floorT": wood tone color,
 "marble": one of ${JSON.stringify(MARBLES)}, "mantel": "marble" | "walnut" | "none", "above": one of ${JSON.stringify(ABOVE)},
 "sofaF": one of ${JSON.stringify(FABRICS)} or a #rrggbb color, "chairF": same, "table": one of ${JSON.stringify(TABLES)}, "rug": one of ${JSON.stringify(RUGS)},
 "drapes": "none" | "panels" | "roman", "drapeColor": color, "crown": true|false, "sconces": true|false }
Keep wall colors realistic paint colors. Accent walls are fine.`
};

function extractJson(t) {
  t = String(t || '').replace(/```(?:json)?/g, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('No JSON in model reply');
  return JSON.parse(t.slice(a, b + 1));
}
const hex = v => /^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v) : null;
const clampN = (v, lo, hi) => { const n = parseFloat(v); return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };
const pick = (v, list) => list.includes(v) ? v : null;

function cleanItem(o) {
  const kind = pick(o.kind, KINDS) || 'other';
  return { name: String(o.name || 'New item').slice(0, 60), kind, w: clampN(o.w, 2, 240), d: clampN(o.d, 0.5, 200), h: kind === 'rug' ? 0.5 : clampN(o.h, 0.5, 120), color: hex(o.color), notes: String(o.notes || '').slice(0, 300) };
}
function cleanScheme(o) {
  const out = { summary: String(o.summary || '').slice(0, 200) };
  if (o.walls && typeof o.walls === 'object') { out.walls = {}; for (const g of ['fire','window','entry','opening']) { const w = o.walls[g]; if (w && pick(w.f, FINISHES)) out.walls[g] = { f: w.f, c: hex(w.c) || '#EDE8DE' }; } }
  if (o.floorP === 'herringbone' || o.floorP === 'plank') out.floorP = o.floorP;
  if (hex(o.floorT)) out.floorT = hex(o.floorT);
  if (pick(o.marble, MARBLES)) out.marble = o.marble;
  if (['marble','walnut','none'].includes(o.mantel)) out.mantel = o.mantel;
  if (pick(o.above, ABOVE)) out.above = o.above;
  for (const k of ['sofaF','chairF']) { if (pick(o[k], FABRICS) || hex(o[k])) out[k] = o[k]; }
  if (pick(o.table, TABLES)) out.table = o.table;
  if (pick(o.rug, RUGS)) out.rug = o.rug;
  if (['none','panels','roman'].includes(o.drapes)) out.drapes = o.drapes;
  if (hex(o.drapeColor)) out.drapeColor = hex(o.drapeColor);
  if (typeof o.crown === 'boolean') out.crown = o.crown;
  if (typeof o.sconces === 'boolean') out.sconces = o.sconces;
  return out;
}

async function viaAnthropic(sys, text, image) {
  const content = [];
  if (image) { const m = image.match(/^data:(image\/[a-z]+);base64,(.+)$/); if (m) content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }); }
  content.push({ type: 'text', text: text || 'Use the photo.' });
  const models = (process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5,claude-sonnet-4-5').split(',');
  let last;
  for (const model of models) {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: model.trim(), max_tokens: 900, system: sys, messages: [{ role: 'user', content }] }), signal: AbortSignal.timeout(45000) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) return (j.content || []).map(c => c.text || '').join('');
    last = (j.error && j.error.message) || ('HTTP ' + r.status);
    if (r.status !== 404 && !/model/i.test(last)) break;
  }
  throw new Error(last);
}
async function viaGateway(sys, text, image, token) {
  const content = [{ type: 'text', text: text || 'Use the photo.' }];
  if (image) content.push({ type: 'image_url', image_url: { url: image } });
  const models = (process.env.AI_MODEL || 'anthropic/claude-sonnet-5.5,anthropic/claude-sonnet-4.5,anthropic/claude-sonnet-4').split(',');
  let last;
  for (const model of models) {
    const r = await fetch('https://ai-gateway.vercel.sh/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ model: model.trim(), max_tokens: 900, temperature: 0.5, messages: [{ role: 'system', content: sys }, { role: 'user', content }] }), signal: AbortSignal.timeout(45000) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) return ((j.choices || [])[0] || {}).message?.content || '';
    last = (j.error && (j.error.message || j.error)) || ('HTTP ' + r.status);
    if (r.status === 401 || r.status === 403) break;
  }
  throw new Error(String(last));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const mode = b.mode === 'scheme' ? 'scheme' : 'item';
  const text = String(b.text || '').slice(0, 2000);
  const image = typeof b.image === 'string' && b.image.length < 3_500_000 && b.image.startsWith('data:image/') ? b.image : null;
  if (!text && !image) return res.status(400).json({ error: 'Describe it or add a photo first' });
  try {
    let reply;
    if (process.env.ANTHROPIC_API_KEY) reply = await viaAnthropic(SYS[mode], text, image);
    else {
      const token = process.env.AI_GATEWAY_API_KEY || req.headers['x-vercel-oidc-token'] || process.env.VERCEL_OIDC_TOKEN;
      if (!token) return res.status(503).json({ error: 'AI isn’t set up on this site yet' });
      reply = await viaGateway(SYS[mode], text, image, token);
    }
    const o = extractJson(reply);
    return res.status(200).json(mode === 'scheme' ? cleanScheme(o) : cleanItem(o));
  } catch (e) {
    return res.status(502).json({ error: String((e && e.message) || e).slice(0, 300) });
  }
}

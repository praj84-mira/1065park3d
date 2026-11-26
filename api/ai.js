import { get } from '@vercel/blob';
// Turns a description and/or reference photo into either a furniture item or a room "look".
// Auth: ANTHROPIC_API_KEY (direct) if set; otherwise Vercel AI Gateway via AI_GATEWAY_API_KEY or the deployment's OIDC token.
const KINDS = ['sofa','sectional','chair','slipper','swivel','ottoman','coffee','roundtable','side','console','bench','bookcase','lamp','plant','rug','art','other'];
const FINISHES = ['paint','limewash','molding','grasscloth','oak','walnut','trellis','stripe'];
const MARBLES = ['calacatta','bardiglio','nero','verde','travertine','limestone'];
const FABRICS = ['oatmeal','boucle','camel','sage','navy','rust','mustard','blush','charcoal'];
const TABLES = ['walnut','oak','travertine','lacquer'];
const RUGS = ['ivory','vintage','blue','jute','charcoal'];
const ABOVE = ['abstract','landscape','mirror','tv','none'];

const ROOM = 'Living room in a 1950s Upper East Side co-op: ~15x15 ft plus a window bay with a wide steel-framed window, ceiling ~8.5 ft, a fireplace set flush in the left (west) wall, square-headed openings (dining to the west, kitchen to the east, entry hall to the south), herringbone wood floor planned, crown molding.';

const SYS = {
  item: `You help a couple visualise furniture in their ${ROOM}
From the user's description and/or photo, produce ONE furniture item as strict JSON, no prose:
{"name": short product-style name (max 50 chars), "kind": one of ${JSON.stringify(KINDS)}, "w": width inches, "d": depth inches, "h": height inches, "color": main visible color as #rrggbb, "notes": one or two sentences on what it is (style, material) }
For rugs, w and d are length and width in inches (e.g. 9x12 ft rug = w 144, d 108) and h 0.5. Use typical real-world dimensions when not stated. Pick the closest kind.`,
  scheme: `You are an interior designer editing a 3D mock-up of a ${ROOM}
Apply the user's request (text and/or reference photo) by calling the apply_changes tool. Change ONLY what the request asks for or clearly implies; leave everything else out of the call.

Coordinates are in feet, seen from above: x runs 0 (fireplace wall, west) to 15.25 (wide opening to the dining room, east). z runs 0 (window wall, north) to 15.3 (entry wall, south).
- Window bay: a recess between x 2.6 and 12.6, from z 0 back to z -2.2; the big window is at its back. A small second window is on the east wall near z 0.2-2.3.
- Fireplace: centred on the west wall at z 4.1 (surround spans z 1.6-6.6, hearth projects to x 1.5). A square-headed 4.4 ft opening to the dining area is on the west wall at z 10.6-15.0.
- Entry: square-headed opening on the south wall at x 2.45-7.5. East wall: solid from z 0 to 5.9 (corner window at z 0.25-2.25), then a ~9.3 ft square-headed opening to the kitchen (z 5.9-15.2) - nothing can sit in that opening.
- Corners by the windows: north-west near (1.6, 1.4) (beside the fireplace) and north-east near (13.8, 1.4).
Each piece has a position (x, z) at the centre of its footprint and a rotation r in degrees. At r=0 the front (seat or keyboard side) faces +z (south, toward the entry); r=180 faces the windows; r=-90 faces the fireplace; r=90 faces the dining room. Use the given footprints (w along local x, d along local z) to keep pieces inside the room, off each other, and at least 2.5 ft clear of walkways through the openings.
To remove pieces, list their ids. To add pieces, use only the listed types. Wall finishes are one of ${JSON.stringify(FINISHES)}; "fire" is the fireplace wall. Colours are #rrggbb. Keep wall colours realistic paint colours.`
};

function extractJson(t) {
  t = String(t || '').replace(/```(?:json)?/g, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('No JSON in model reply');
  let j = t.slice(a, b + 1);
  try { return JSON.parse(j); } catch {}
  j = j.replace(/\/\/[^\n]*/g, '').replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(j);
}
const SCHEME_TOOL = {
  name: 'apply_changes',
  description: 'Apply changes to the living-room mock-up. Include only the fields that should change.',
  input_schema: { type: 'object', properties: {
    summary: { type: 'string', description: 'One short sentence describing what changed' },
    walls: { type: 'object', description: 'Only the walls to change', properties: Object.fromEntries(['fire','window','entry','opening'].map(g => [g, { type: 'object', properties: { f: { type: 'string', enum: FINISHES }, c: { type: 'string' } }, required: ['f', 'c'] }])) },
    floorP: { type: 'string', enum: ['herringbone', 'plank'] }, floorT: { type: 'string', description: 'wood tone #rrggbb; darker is lower lightness' },
    marble: { type: 'string', enum: MARBLES }, mantel: { type: 'string', enum: ['marble', 'walnut', 'none'] }, above: { type: 'string', enum: ABOVE },
    sofaF: { type: 'string', description: 'fabric id ' + FABRICS.join('/') + ' or #rrggbb' }, chairF: { type: 'string', description: 'same as sofaF' },
    table: { type: 'string', enum: TABLES }, rug: { type: 'string', enum: RUGS, description: 'pattern for rugs in the room' },
    drapes: { type: 'string', enum: ['none', 'panels', 'roman'] }, drapeColor: { type: 'string' }, crown: { type: 'boolean' }, sconces: { type: 'boolean' },
    remove: { type: 'array', items: { type: 'string' }, description: 'ids of pieces to remove' },
    add: { type: 'array', items: { type: 'object', properties: { t: { type: 'string' }, x: { type: 'number' }, z: { type: 'number' }, r: { type: 'number' } }, required: ['t', 'x', 'z'] } },
    move: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, x: { type: 'number' }, z: { type: 'number' }, r: { type: 'number' } }, required: ['id'] } }
  }, required: ['summary'] }
};
const ITEM_TOOL = {
  name: 'make_item',
  description: 'Describe one furniture item.',
  input_schema: { type: 'object', properties: {
    name: { type: 'string' }, kind: { type: 'string', enum: KINDS }, w: { type: 'number', description: 'width in inches (rug: length)' }, d: { type: 'number', description: 'depth in inches (rug: width)' }, h: { type: 'number', description: 'height in inches' },
    color: { type: 'string', description: '#rrggbb main visible colour' }, notes: { type: 'string', description: 'one or two sentences on what it is' }
  }, required: ['name', 'kind', 'w', 'd', 'h'] }
};

const hex = v => /^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v) : null;
const clampN = (v, lo, hi) => { const n = parseFloat(v); return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };
const pick = (v, list) => list.includes(v) ? v : null;

function cleanItem(o) {
  const kind = pick(o.kind, KINDS) || 'other';
  return { name: String(o.name || 'New item').slice(0, 60), kind, w: clampN(o.w, 2, 240), d: clampN(o.d, 0.5, 200), h: kind === 'rug' ? 0.5 : clampN(o.h, 0.5, 120), color: hex(o.color), notes: String(o.notes || '').slice(0, 300) };
}
function cleanScheme(o, ctx) {
  const out = { summary: String(o.summary || '').slice(0, 200) };
  const ids = new Set((ctx.items || []).map(i => String(i.id)));
  const types = new Set((ctx.catalog || []).map(c => String(c.t)));
  const num = (v, lo, hi, dflt) => { const n = parseFloat(v); return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };
  if (Array.isArray(o.remove)) out.remove = o.remove.map(String).filter(id => ids.has(id));
  if (Array.isArray(o.add)) out.add = o.add.filter(a => a && types.has(String(a.t))).slice(0, 12).map(a => ({ t: String(a.t), x: num(a.x, -0.5, 16, 7.6), z: num(a.z, -2.2, 15.5, 7), r: num(a.r, -360, 360, 0) }));
  if (Array.isArray(o.move)) out.move = o.move.filter(m => m && ids.has(String(m.id))).map(m => ({ id: String(m.id), x: num(m.x, -0.5, 16, null), z: num(m.z, -2.2, 15.5, null), r: m.r == null ? null : num(m.r, -360, 360, 0) }));
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

async function loadFiles(list) {
  const blocks = [];
  for (const f of (Array.isArray(list) ? list : []).slice(0, 4)) {
    const p = String((f && f.path) || '');
    if (!/^lr13ab\/files\/[a-z0-9]+\.(jpg|png|webp|gif|pdf)$/.test(p)) continue;
    const r = await get(p, { access: 'private' }).catch(() => null);
    if (!r || r.statusCode !== 200 || !r.stream) continue;
    const data = Buffer.from(await new Response(r.stream).arrayBuffer()).toString('base64');
    const type = r.blob.contentType || '';
    if (type === 'application/pdf') blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } });
    else if (type.startsWith('image/')) blocks.push({ type: 'image', source: { type: 'base64', media_type: type, data } });
  }
  return blocks;
}
async function viaAnthropic(sys, text, image, tool, fileBlocks = []) {
  const content = [...fileBlocks];
  if (image) { const m = image.match(/^data:(image\/[a-z]+);base64,(.+)$/); if (m) content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }); }
  content.push({ type: 'text', text: text || 'Use the photo.' });
  const models = (process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5,claude-sonnet-4-5').split(',');
  let last;
  for (const model of models) {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: model.trim(), max_tokens: 2000, system: sys, tools: [tool], tool_choice: { type: 'tool', name: tool.name }, messages: [{ role: 'user', content }] }), signal: AbortSignal.timeout(50000) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) { const tu = (j.content || []).find(c => c.type === 'tool_use'); if (tu && tu.input) return tu.input; return extractJson((j.content || []).map(c => c.text || '').join('')); }
    last = (j.error && j.error.message) || ('HTTP ' + r.status);
    if (r.status !== 404 && !/model/i.test(last)) break;
  }
  throw new Error(last);
}
async function viaGateway(sys, text, image, token) {
  const content = [{ type: 'text', text: text || 'Use the photo.' }];
  // (PDF reading needs ANTHROPIC_API_KEY; the gateway path only sends the inline photo)
  if (image) content.push({ type: 'image_url', image_url: { url: image } });
  const models = (process.env.AI_MODEL || 'anthropic/claude-sonnet-5.5,anthropic/claude-sonnet-4.5,anthropic/claude-sonnet-4').split(',');
  let last;
  for (const model of models) {
    const r = await fetch('https://ai-gateway.vercel.sh/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ model: model.trim(), max_tokens: 2000, temperature: 0.4, messages: [{ role: 'system', content: sys }, { role: 'user', content }] }), signal: AbortSignal.timeout(45000) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) return extractJson(((j.choices || [])[0] || {}).message?.content || '');
    last = (j.error && (j.error.message || j.error)) || ('HTTP ' + r.status);
    if (r.status === 401 || r.status === 403) break;
  }
  throw new Error(String(last));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const mode = b.mode === 'scheme' ? 'scheme' : 'item';
  let text = String(b.text || '').slice(0, 2000);
  const ctx = b.context && typeof b.context === 'object' ? b.context : {};
  if (mode === 'scheme') text = 'Request: ' + (text || '(see the photo)') + '\n\nCurrent state:\n' + JSON.stringify({ finishes: ctx.finishes || {}, pieces: (ctx.items || []).slice(0, 60), availableTypes: (ctx.catalog || []).slice(0, 80) });
  const image = typeof b.image === 'string' && b.image.length < 3_500_000 && b.image.startsWith('data:image/') ? b.image : null;
  const hasFiles = Array.isArray(b.files) && b.files.length > 0;
  if (!text && !image && !hasFiles) return res.status(400).json({ error: 'Describe it, or add a photo or PDF first' });
  try {
    let o;
    if (process.env.ANTHROPIC_API_KEY) o = await viaAnthropic(SYS[mode] + (hasFiles ? '\nAttached files may include a product photo, a spec sheet or a reference image. Prefer exact dimensions, names and materials stated in a spec sheet over guesses.' : ''), text, image, mode === 'scheme' ? SCHEME_TOOL : ITEM_TOOL, hasFiles ? await loadFiles(b.files) : []);
    else {
      const token = process.env.AI_GATEWAY_API_KEY || req.headers['x-vercel-oidc-token'] || process.env.VERCEL_OIDC_TOKEN;
      if (!token) return res.status(503).json({ error: 'AI isn’t set up on this site yet' });
      o = await viaGateway(SYS[mode] + '\nReply with only a JSON object matching this schema, no comments: ' + JSON.stringify((mode === 'scheme' ? SCHEME_TOOL : ITEM_TOOL).input_schema), text, image, token);
    }
    return res.status(200).json(mode === 'scheme' ? cleanScheme(o, ctx) : cleanItem(o));
  } catch (e) {
    return res.status(502).json({ error: String((e && e.message) || e).slice(0, 300) });
  }
}

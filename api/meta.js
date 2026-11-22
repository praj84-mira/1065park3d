import { UA, safeUrl } from './_net.js';

const ent = s => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).trim();

function metaMap(html) {
  const m = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const a = {}; let mm; const re = /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    while ((mm = re.exec(tag))) a[mm[1].toLowerCase()] = mm[3] ?? mm[4] ?? mm[5];
    const k = (a.property || a.name || a.itemprop || '').toLowerCase();
    if (k && a.content && !m[k]) m[k] = ent(a.content);
  }
  return m;
}

function findProduct(node, depth = 0) {
  if (!node || depth > 6) return null;
  if (Array.isArray(node)) { for (const n of node) { const p = findProduct(n, depth + 1); if (p) return p; } return null; }
  if (typeof node !== 'object') return null;
  const t = node['@type']; const ts = Array.isArray(t) ? t : [t];
  if (ts.some(x => /product/i.test(String(x || '')))) return node;
  for (const k of ['@graph', 'mainEntity', 'itemListElement', 'item']) { const p = findProduct(node[k], depth + 1); if (p) return p; }
  return null;
}
const num = v => { if (v == null) return null; if (typeof v === 'object') v = v.value ?? v['@value']; const n = parseFloat(String(v).replace(/[^\d.]/g, '')); return isFinite(n) && n > 0 ? n : null; };
const firstImg = im => { if (!im) return null; if (Array.isArray(im)) return firstImg(im[0]); if (typeof im === 'object') return im.url || im.contentUrl || null; return im; };

function dimsFromText(text) {
  const t = text.replace(/[”″]/g, '"').replace(/[’′]/g, "'").replace(/\s+/g, ' ');
  const N = '(\\d{1,3}(?:\\.\\d+)?)(?:\\s*(?:-|\\s)\\s*(\\d)\\/(\\d))?', U = '\\s*(?:"|in\\.?|inches|cm)?\\s*';
  const re = new RegExp(N + U + '([WDHL])\\b\\s*[x×X]\\s*' + N + U + '([WDHL])\\b(?:\\s*[x×X]\\s*' + N + U + '([WDHL])\\b)?', 'i');
  const m = t.match(re);
  if (m) {
    const val = (a, b, c) => parseFloat(a) + (b && c ? (+b) / (+c) : 0);
    const out = {}; const cm = /cm/i.test(m[0]);
    const put = (v, l) => { if (!l) return; l = l.toUpperCase(); if (l === 'L') l = 'W'; out[l.toLowerCase()] = cm ? +(v / 2.54).toFixed(1) : v; };
    put(val(m[1], m[2], m[3]), m[4]); put(val(m[5], m[6], m[7]), m[8]); if (m[9]) put(val(m[9], m[10], m[11]), m[12]);
    if (out.w) return out;
  }
  const lab = k => { const r = t.match(new RegExp('\\b' + k + '\\s*(?:\\(in(?:ches)?\\))?\\s*[:\\-]?\\s*(\\d{1,3}(?:\\.\\d+)?)\\s*(?:"|in)', 'i')); return r ? parseFloat(r[1]) : null; };
  const w = lab('(?:overall\\s+)?width'), d = lab('(?:overall\\s+)?depth'), h = lab('(?:overall\\s+)?height');
  if (w || d || h) return { w, d, h };
  const rug = t.match(/\b(\d{1,2})\s*'\s*(?:(\d{1,2})\s*"?\s*)?[x×X]\s*(\d{1,2})\s*'\s*(?:(\d{1,2})\s*")?/);
  if (rug) { const a = (+rug[1]) * 12 + (+(rug[2] || 0)), b = (+rug[3]) * 12 + (+(rug[4] || 0)); return { w: Math.max(a, b), d: Math.min(a, b), h: 0.5 }; }
  return null;
}

function guessKind(s) {
  s = (s || '').toLowerCase();
  const rules = [['sectional', /sectional/], ['rug', /\brug\b|runner|kilim|dhurrie/], ['sofa', /sofa|couch|settee|loveseat|chesterfield/], ['swivel', /swivel|barrel chair/], ['slipper', /slipper chair|armless/],
    ['chair', /chair|recliner|fauteuil|bergere/], ['ottoman', /ottoman|pouf|pouffe|footstool/], ['roundtable', /round (coffee|cocktail)|drum table/], ['coffee', /coffee table|cocktail table/],
    ['side', /side table|end table|accent table|drink table|martini table/], ['console', /console|sideboard|credenza|buffet|media/], ['bench', /\bbench\b/], ['bookcase', /bookcase|bookshelf|etagere|étagère|shelving/],
    ['lamp', /floor lamp|lamp/], ['plant', /plant|tree|fig|olive|palm/], ['art', /print|painting|canvas|artwork|\bart\b|mirror/]];
  for (const [k, re] of rules) if (re.test(s)) return k;
  return 'other';
}

export default async function handler(req, res) {
  const url = safeUrl(req.query.url);
  if (!url) return res.status(400).json({ ok: false, reason: 'bad-url' });
  let html = '', status = 0;
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'en-US,en;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(10000) });
    status = r.status; html = (await r.text()).slice(0, 4_000_000);
  } catch { return res.status(200).json({ ok: false, reason: 'fetch-failed' }); }
  const m = metaMap(html);
  let prod = null;
  for (const s of html.match(/<script[^>]*application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi) || []) {
    try { const j = JSON.parse(s.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '')); prod = findProduct(j); if (prod) break; } catch {}
  }
  const titleTag = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  const title = ent((prod && prod.name) || m['og:title'] || m['twitter:title'] || titleTag || '');
  let image = firstImg(prod && prod.image) || m['og:image'] || m['og:image:secure_url'] || m['twitter:image'] || null;
  if (image) { try { image = new URL(image, url).href; } catch { image = null; } }
  const offers = prod && (Array.isArray(prod.offers) ? prod.offers[0] : prod.offers);
  const price = (offers && (offers.price || offers.lowPrice || (offers.priceSpecification && offers.priceSpecification.price))) || m['product:price:amount'] || m['og:price:amount'] || null;
  const currency = (offers && offers.priceCurrency) || m['product:price:currency'] || m['og:price:currency'] || 'USD';
  const desc = ent((prod && prod.description) || m['og:description'] || m['description'] || '').slice(0, 400);
  let dims = null;
  if (prod) { const w = num(prod.width), d = num(prod.depth), h = num(prod.height); if (w || d || h) dims = { w, d, h }; }
  if (!dims) {
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
    dims = dimsFromText(ent(text)) || dimsFromText(title + ' ' + desc);
  }
  const brand = prod && prod.brand ? (typeof prod.brand === 'string' ? prod.brand : prod.brand.name) : (m['og:site_name'] || url.hostname.replace(/^www\./, ''));
  res.setHeader('cache-control', 'public, s-maxage=86400');
  return res.status(200).json({ ok: !!(title || image), status, title, image, price: price ? String(price) : null, currency, desc, dims, brand, kind: guessKind(title + ' ' + (prod && prod.category || '')) });
}

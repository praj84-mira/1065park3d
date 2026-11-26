import { put, get } from '@vercel/blob';

const PATH = 'lr13ab/data.json';
export const empty = () => ({ versions: [], items: [], renders: [] });

export async function read() {
  const r = await get(PATH, { access: 'private', useCache: false });
  if (!r || r.statusCode !== 200 || !r.stream) return empty();
  const txt = await new Response(r.stream).text();
  try {
    const d = JSON.parse(txt);
    return { versions: Array.isArray(d.versions) ? d.versions : [], items: Array.isArray(d.items) ? d.items : [], renders: Array.isArray(d.renders) ? d.renders : [] };
  } catch { return empty(); }
}

export async function write(d) {
  const body = JSON.stringify(d);
  await put(PATH, body, { access: 'private', allowOverwrite: true, addRandomSuffix: false, contentType: 'application/json' });
  // keep a rolling backup trail in case something gets deleted by mistake
  await put(`lr13ab/backups/${Date.now()}.json`, body, { access: 'private', contentType: 'application/json' }).catch(() => {});
}

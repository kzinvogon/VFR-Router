// Netlify Function: proxy OpenAIP airport search.
// Two modes (mirrors server.js):
//   ?search=<str>  typeahead — needs ≥2 chars
//   ?bbox=...      bulk in-region for A* turn-points

const UPSTREAM = 'https://api.core.openaip.net/api/airports';

export default async (req) => {
  const key = process.env.OPENAIP_API_KEY;
  if (!key) {
    return json({ error: 'OPENAIP_API_KEY not configured' }, 500);
  }

  const url = new URL(req.url);
  const search = (url.searchParams.get('search') || '').trim();
  const bbox   = (url.searchParams.get('bbox')   || '').trim();

  if (!search && !bbox)      return json({ items: [] }, 200);
  if (search && search.length < 2) return json({ items: [] }, 200);

  const limit = url.searchParams.get('limit') || (bbox ? '1000' : '10');
  const page  = url.searchParams.get('page')  || '1';
  const qs = new URLSearchParams({ limit, page });
  if (search) qs.set('search', search);
  if (bbox)   qs.set('bbox',   bbox);
  const upstream = `${UPSTREAM}?${qs.toString()}`;

  try {
    const r = await fetch(upstream, {
      headers: { 'x-openaip-api-key': key, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    const body = await r.text();
    return new Response(body, {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    return json({ error: err?.message || 'upstream error' }, 502);
  }
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export const config = { path: '/api/airports' };

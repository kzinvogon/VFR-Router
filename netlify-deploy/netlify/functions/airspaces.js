// Netlify Function: proxy OpenAIP airspace queries.
// Mirrors server.js /api/airspaces — same path so the router HTML is unchanged.
// Reads OPENAIP_API_KEY from Netlify env (Site → Configuration → Environment).

const UPSTREAM = 'https://api.core.openaip.net/api/airspaces';

export default async (req) => {
  const key = process.env.OPENAIP_API_KEY;
  if (!key) {
    return json({ error: 'OPENAIP_API_KEY not configured' }, 500);
  }

  const url = new URL(req.url);
  const bbox  = url.searchParams.get('bbox')  || '';
  const limit = url.searchParams.get('limit') || '300';
  const page  = url.searchParams.get('page')  || '1';
  if (!bbox) return json({ error: 'bbox required' }, 400);

  const qs = new URLSearchParams({ bbox, limit, page });
  const upstream = `${UPSTREAM}?${qs.toString()}`;

  try {
    const r = await fetch(upstream, {
      headers: { 'x-openaip-api-key': key, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    const body = await r.text();
    const headers = { 'content-type': 'application/json' };
    const retryAfter = r.headers.get('retry-after');
    if (retryAfter) headers['retry-after'] = retryAfter;
    return new Response(body, { status: r.status, headers });
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

export const config = { path: '/api/airspaces' };

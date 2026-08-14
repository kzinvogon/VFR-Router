// Netlify Function: proxy OpenAIP airspace queries.
// Mirrors server.js /api/airspaces — same path so the router HTML is unchanged.
// Reads OPENAIP_API_KEY from Netlify env (Site → Configuration → Environment).

import { getCachedResponse, setCachedResponse } from './_lib/openaip-cache.js';

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
  const cacheKey = `airspaces:${qs.toString()}`;

  const cached = await getCachedResponse(cacheKey);
  if (cached) {
    return new Response(cached.body, {
      status: cached.status,
      headers: { 'content-type': 'application/json', 'x-cache': 'HIT' },
    });
  }

  const upstream = `${UPSTREAM}?${qs.toString()}`;

  try {
    const r = await fetch(upstream, {
      headers: { 'x-openaip-api-key': key, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    const body = await r.text();
    if (r.ok) await setCachedResponse(cacheKey, r.status, body);
    const headers = { 'content-type': 'application/json', 'x-cache': 'MISS' };
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

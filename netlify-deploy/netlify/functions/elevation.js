// Netlify Function: proxy OpenTopoData (SRTM 30m) elevation queries.
// Mirrors server.js /api/elevation. Public service, no API key required.

const UPSTREAM = 'https://api.opentopodata.org/v1/srtm30m';

export default async (req) => {
  const url = new URL(req.url);
  const locations = url.searchParams.get('locations') || '';
  if (!locations) return json({ error: 'locations required' }, 400);

  const upstream = `${UPSTREAM}?locations=${encodeURIComponent(locations)}`;
  try {
    const r = await fetch(upstream, {
      headers: { 'Accept': 'application/json' },
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

export const config = { path: '/api/elevation' };

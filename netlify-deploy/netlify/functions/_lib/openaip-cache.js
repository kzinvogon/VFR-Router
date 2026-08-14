// Response cache for the OpenAIP proxy functions, backed by Netlify Blobs.
// Airspace/airport data changes on an AIRAC-ish cadence (weeks), not per
// request, so caching successful upstream responses lets repeat and
// geographically-overlapping route lookups skip OpenAIP entirely — the main
// lever against OpenAIP's rate limit, since a single tiled bbox fetch can
// fan out into a dozen-plus upstream calls.

import { getStore } from '@netlify/blobs';

const STORE = 'vfr-openaip-cache';
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export async function getCachedResponse(key) {
  const store = getStore({ name: STORE, consistency: 'strong' });
  const entry = await store.get(key, { type: 'json' });
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) return null;
  return { status: entry.status, body: entry.body };
}

export async function setCachedResponse(key, status, body) {
  const store = getStore({ name: STORE, consistency: 'strong' });
  await store.set(key, JSON.stringify({ status, body, ts: Date.now() }));
}

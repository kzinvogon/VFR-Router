// /api/corpus — back-compat shim. The corpus is now the unified `vfr-logs`
// store served by /api/logs (see logs.js). This endpoint is preserved as a
// read-only adapter so any external callers / cached URLs keep working, but
// new writes must go through /api/logs.
//
//   GET /api/corpus              → same as /api/logs (returns items[] in the old shape)
//   GET /api/corpus?q=foo        → free-text filter on dep/dest/source/note/contributor
//   GET /api/corpus?dep=LEMU     → exact dep match
//   GET /api/corpus?dest=LEBA    → exact dest match
//   POST   /api/corpus           → 410 Gone, points to /api/logs
//   DELETE /api/corpus           → 410 Gone, points to /api/logs

import { getStore } from '@netlify/blobs';

const LOGS_STORE = 'vfr-logs';
const MIGRATION_MARKER = '_corpus_migrated';

function matchesQuery(r, q) {
  q = q.toLowerCase();
  return (r.dep || '').toLowerCase().includes(q)
      || (r.dest || '').toLowerCase().includes(q)
      || (r.source || '').toLowerCase().includes(q)
      || (r.note || '').toLowerCase().includes(q)
      || (r.contributorName || '').toLowerCase().includes(q);
}

function toCorpusItem(log) {
  // Map the unified log shape back to the legacy `items[]` shape so any
  // pre-existing consumers (browser caches, external integrations) still parse.
  return {
    id: log.id,
    dep: log.dep,
    dest: log.dest,
    via: log.via || [],
    altsFt: log.altsFt || [],
    source: log.source || 'PLOG',
    note: log.note || '',
    contributorName: log.contributorName || 'anonymous',
    contributedAt: log.importedAt,
  };
}

export default async (req) => {
  if (req.method === 'POST' || req.method === 'DELETE') {
    return json(
      {
        error: 'gone',
        message: 'POST/DELETE on /api/corpus has been retired. Use /api/logs instead.',
        replacement: '/api/logs',
      },
      410
    );
  }

  if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405);

  const store = getStore({ name: LOGS_STORE, consistency: 'strong' });
  const { blobs } = await store.list();
  const logs = await Promise.all(
    blobs
      .filter(b => b.key !== MIGRATION_MARKER)
      .map(b => store.get(b.key, { type: 'json' }))
  );
  // Match /api/logs default: only approved entries (legacy entries without
  // a status field are treated as approved).
  let routes = logs
    .filter(Boolean)
    .filter(l => (l.status || 'approved') === 'approved')
    .map(toCorpusItem);

  const url = new URL(req.url);
  const q = (url.searchParams.get('q') || '').trim();
  const dep = (url.searchParams.get('dep') || '').toUpperCase();
  const dest = (url.searchParams.get('dest') || '').toUpperCase();
  if (dep) routes = routes.filter(r => r.dep === dep);
  if (dest) routes = routes.filter(r => r.dest === dest);
  if (q) routes = routes.filter(r => matchesQuery(r, q));
  routes.sort((a, b) => (b.contributedAt || '').localeCompare(a.contributedAt || ''));

  return json({ items: routes, total: routes.length, filtered: routes.length }, 200);
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export const config = { path: '/api/corpus' };

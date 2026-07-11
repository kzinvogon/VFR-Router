// /api/plans/* — save / list / delete computed routes per user.
// Plans are stored as JSON blobs in the `vfr-plans` store keyed by plan id;
// each plan has the owner's email so `?scope=mine` filters cheaply.

import { getStore } from '@netlify/blobs';
import { PLANS, jsonResp, getUserFromRequest } from './_lib/auth-helpers.js';

function makePlanId() {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export default async (req) => {
  const user = await getUserFromRequest(req);
  if (!user) return jsonResp({ error: 'auth required' }, 401);

  const url = new URL(req.url);
  const action = url.pathname.replace(/^\/api\/plans\/?/, '').replace(/\/$/, '');
  const store = getStore({ name: PLANS, consistency: 'strong' });

  // ── SAVE A PLAN ─────────────────────────────────────────────────────────
  if (req.method === 'POST' && !action) {
    const body = await req.json().catch(() => null);
    if (!body) return jsonResp({ error: 'invalid body' }, 400);
    if (!body.dep || !body.dest) return jsonResp({ error: 'dep and dest required' }, 400);
    if (!Array.isArray(body.path)) return jsonResp({ error: 'path must be array' }, 400);

    const id = makePlanId();
    const plan = {
      id,
      email: user.email,
      pilotName: `${user.firstName} ${user.lastName}`.trim(),
      dep: body.dep,
      dest: body.dest,
      label: (body.label || `${body.dep} → ${body.dest}`).slice(0, 200),
      path: body.path,        // [{ name, lat, lon }, ...]
      legs: body.legs || [],  // [{ a, b, course, distNm, pick: { level, ... } }, ...]
      totalNm: typeof body.totalNm === 'number' ? body.totalNm : null,
      tasKt: typeof body.tasKt === 'number' ? body.tasKt : null,
      preferredFt: typeof body.preferredFt === 'number' ? body.preferredFt : null,
      ceilingFt: typeof body.ceilingFt === 'number' ? body.ceilingFt : null,
      warnings: body.warnings || [],
      source: body.source || 'router',  // 'router' or 'corpus'
      createdAt: new Date().toISOString(),
    };
    await store.set(id, JSON.stringify(plan));
    return jsonResp({ ok: true, plan }, 200);
  }

  // ── LIST PLANS ──────────────────────────────────────────────────────────
  if (req.method === 'GET' && !action) {
    const scope = url.searchParams.get('scope') || 'mine';
    if (scope === 'all' && !user.isAdmin) return jsonResp({ error: 'admin only' }, 403);
    const { blobs } = await store.list();
    const plans = await Promise.all(blobs.map(b => store.get(b.key, { type: 'json' })));
    let filtered = plans.filter(Boolean);
    if (scope === 'mine') filtered = filtered.filter(p => p.email === user.email);
    filtered.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return jsonResp({ plans: filtered, scope, total: filtered.length }, 200);
  }

  // ── DELETE A PLAN ───────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const id = url.searchParams.get('id');
    if (!id) return jsonResp({ error: 'id query param required' }, 400);
    const plan = await store.get(id, { type: 'json' });
    if (!plan) return jsonResp({ error: 'not found' }, 404);
    if (plan.email !== user.email && !user.isAdmin) return jsonResp({ error: 'not your plan' }, 403);
    await store.delete(id);
    return jsonResp({ ok: true, removed: plan }, 200);
  }

  return jsonResp({ error: 'method/action not supported' }, 405);
};

export const config = { path: ['/api/plans', '/api/plans/*'] };

// /api/logs — the unified, centralised corpus of pilot-uploaded flight logs.
//
// Every upload joins the global knowledge base. Ownership is recorded (email
// + contributor name), but visibility is global: any caller — anonymous
// router visitor included — sees the whole corpus. `?scope=mine` is the
// owner-filtered view used by the contribute page; it requires auth.
//
//   POST   /api/logs                  → upload a parsed log (auth required)
//   GET    /api/logs                  → list APPROVED logs (default; anonymous OK)
//   GET    /api/logs?scope=mine       → list caller's logs (any status; auth required)
//   GET    /api/logs?status=pending   → admin moderation queue (admin only)
//   GET    /api/logs?status=all       → every log regardless of status (admin only)
//   GET    /api/logs?id=<id>          → fetch one log (anonymous OK)
//   PATCH  /api/logs?id=<id>          → update outcome metadata (owner or admin)
//   POST   /api/logs/<id>/moderate    → approve or reject (admin only)
//   DELETE /api/logs?id=<id>          → delete a log (owner or admin)
//
// Schema:
//   dep, dest, via[], altsFt[]       — the route itself (immutable post-upload)
//   aircraft                          — free text "EC-XYZ / SR22"; pre-filled from profile.aircraftType
//   flightDate (YYYY-MM-DD | null)    — date the flight was flown / planned for
//   country (ISO-2 | "??")            — auto-derived from dep ICAO prefix
//   cruiseAltFt (number | null)       — planned cruise altitude
//   outcome                           — 'planned' | 'accepted' | 'rejected' | 'amended' | null
//   atcAmendments                     — free text describing ATC's changes
//   status                            — 'pending' | 'approved' | 'rejected' (moderation state)
//   moderatedBy, moderatedAt, moderationReason  — set when an admin acts
//   source, note, importedAt, updatedAt
//
// Moderation gate: new uploads land as `pending`. Only `approved` logs are
// returned by the default `scope=all` view that the planner consumes — a
// pending or rejected upload does NOT affect VALIDATED_ROUTES. Admin uploads
// auto-approve (they're trusted). Legacy-migrated entries auto-approve (they
// were already public before the gate existed). Owner-view (`scope=mine`)
// returns all of the caller's entries regardless of status so they can see
// their pending uploads.
//
// One-time migration: on first read, entries in the legacy `vfr-corpus`
// /index blob are imported into `vfr-logs` (each becomes its own per-key
// blob with a synthetic owner email). A marker key `_corpus_migrated`
// prevents re-running.

import { getStore } from '@netlify/blobs';
import { jsonResp, getUserFromRequest } from './_lib/auth-helpers.js';
import { checkAll, clientIp, rateLimitResponse, ONE_HOUR_MS } from './_lib/rate-limit.js';
import { sendEmail, uploadAckEmail, logApprovedEmail, logRejectedEmail } from './_lib/email.js';

const LOGS = 'vfr-logs';
const LEGACY_CORPUS_STORE = 'vfr-corpus';
const LEGACY_CORPUS_INDEX = 'index';
const MIGRATION_MARKER = '_corpus_migrated';

const ICAO_RE = /^[A-Z]{4}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const OUTCOMES = ['planned', 'accepted', 'rejected', 'amended'];

// ICAO 2-letter prefix → ISO 3166-1 alpha-2 country code. European focus;
// extended as the corpus grows. Returns '??' when the prefix is unknown.
const ICAO_COUNTRY = {
  // Iberia
  LE: 'ES', GC: 'ES', LP: 'PT',
  // Western Europe
  LF: 'FR', LI: 'IT', LS: 'CH', LO: 'AT', LM: 'MT',
  // British Isles
  EG: 'GB', EI: 'IE',
  // Benelux + Germany
  ED: 'DE', ET: 'DE', EH: 'NL', EB: 'BE', EL: 'LU',
  // Nordics
  EK: 'DK', ES: 'SE', EN: 'NO', EF: 'FI', BI: 'IS',
  // Central / Eastern
  EP: 'PL', LK: 'CZ', LH: 'HU', LZ: 'SK', LR: 'RO', LB: 'BG',
  LD: 'HR', LJ: 'SI', LQ: 'BA', LY: 'RS', LW: 'MK', LA: 'AL',
  // Baltics
  EV: 'LV', EE: 'EE', EY: 'LT',
  // SE Europe
  LG: 'GR', LC: 'CY', LT: 'TR',
};
function deriveCountry(icao) {
  if (typeof icao !== 'string' || icao.length < 2) return '??';
  return ICAO_COUNTRY[icao.slice(0, 2).toUpperCase()] || '??';
}

function makeLogId() {
  return `l_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Validators for the optional metadata fields. Returns null when value is
// acceptable (including missing) or a string error message otherwise.
function validateOptionalMeta(body) {
  if (body.aircraft != null) {
    if (typeof body.aircraft !== 'string') return 'aircraft must be a string';
    if (body.aircraft.length > 120) return 'aircraft too long (max 120)';
  }
  if (body.flightDate != null && body.flightDate !== '') {
    if (typeof body.flightDate !== 'string' || !DATE_RE.test(body.flightDate)) {
      return 'flightDate must be YYYY-MM-DD';
    }
  }
  if (body.cruiseAltFt != null) {
    if (typeof body.cruiseAltFt !== 'number' || body.cruiseAltFt < 0 || body.cruiseAltFt > 60000) {
      return 'cruiseAltFt out of range';
    }
  }
  if (body.outcome != null && body.outcome !== '') {
    if (!OUTCOMES.includes(body.outcome)) {
      return `outcome must be one of ${OUTCOMES.join('|')}`;
    }
  }
  if (body.atcAmendments != null) {
    if (typeof body.atcAmendments !== 'string') return 'atcAmendments must be a string';
    if (body.atcAmendments.length > 1000) return 'atcAmendments too long (max 1000)';
  }
  return null;
}

function validateLog(body) {
  if (!body || typeof body !== 'object') return 'body must be an object';
  if (!body.dep || !ICAO_RE.test(body.dep)) return 'dep must be a 4-letter ICAO';
  if (!body.dest || !ICAO_RE.test(body.dest)) return 'dest must be a 4-letter ICAO';
  if (!Array.isArray(body.via)) return 'via must be an array';
  if (body.via.length > 50) return 'too many waypoints (max 50)';
  for (const w of body.via) {
    if (!w || typeof w !== 'object') return 'each via entry must be an object';
    if (w.lat != null && (typeof w.lat !== 'number' || w.lat < -90 || w.lat > 90)) return 'via lat out of range';
    if (w.lon != null && (typeof w.lon !== 'number' || w.lon < -180 || w.lon > 180)) return 'via lon out of range';
    if (w.name && typeof w.name !== 'string') return 'via name must be string';
    if (w.name && w.name.length > 80) return 'via name too long';
  }
  if (body.altsFt != null) {
    if (!Array.isArray(body.altsFt)) return 'altsFt must be an array';
    for (const a of body.altsFt) {
      if (a != null && (typeof a !== 'number' || a < 0 || a > 60000)) return 'altsFt entry out of range';
    }
  }
  return validateOptionalMeta(body);
}

// Idempotent: once the marker is set, this is a single store.get and out.
async function migrateLegacyCorpusOnce(store) {
  const marker = await store.get(MIGRATION_MARKER, { type: 'json' });
  if (marker) return marker;
  let imported = 0;
  try {
    const legacyStore = getStore({ name: LEGACY_CORPUS_STORE, consistency: 'strong' });
    const legacyIdx = await legacyStore.get(LEGACY_CORPUS_INDEX, { type: 'json' });
    const routes = (legacyIdx && Array.isArray(legacyIdx.routes)) ? legacyIdx.routes : [];
    for (const r of routes) {
      if (!r || !r.dep || !r.dest) continue;
      const id = r.id || makeLogId();
      const now = new Date().toISOString();
      const log = {
        id,
        email: '_legacy_corpus@vfr-router',
        contributorName: r.contributorName || 'anonymous (legacy)',
        dep: r.dep,
        dest: r.dest,
        via: Array.isArray(r.via) ? r.via : [],
        altsFt: Array.isArray(r.altsFt) ? r.altsFt : [],
        source: r.source || 'legacy corpus',
        note: r.note || '',
        importedAt: r.contributedAt || now,
        updatedAt: now,
        // Legacy entries were already publicly visible before the moderation
        // gate existed — auto-approve so they keep working for the planner.
        status: 'approved',
        moderatedBy: 'legacy-auto-approve',
        moderatedAt: now,
        migratedFromLegacyCorpus: true,
      };
      await store.set(id, JSON.stringify(log));
      imported++;
    }
  } catch (e) {
    // If the legacy store is empty / missing, that's fine — we still set the marker.
  }
  const done = { migratedAt: new Date().toISOString(), imported };
  await store.set(MIGRATION_MARKER, JSON.stringify(done));
  return done;
}

const VALID_STATUS = ['pending', 'approved', 'rejected'];

export default async (req) => {
  const url = new URL(req.url);
  const store = getStore({ name: LOGS, consistency: 'strong' });
  await migrateLegacyCorpusOnce(store);

  // ── /api/logs/<id>/moderate (admin only) ────────────────────────────────
  // Routed before path-validation so the regex can match the dynamic id.
  const moderateMatch = url.pathname.match(/^\/api\/logs\/([^/]+)\/moderate\/?$/);
  if (moderateMatch) {
    if (req.method !== 'POST') return jsonResp({ error: 'method not allowed' }, 405);
    const user = await getUserFromRequest(req);
    if (!user) return jsonResp({ error: 'auth required' }, 401);
    if (!user.isAdmin) return jsonResp({ error: 'admin only' }, 403);

    const id = moderateMatch[1];
    if (id === MIGRATION_MARKER) return jsonResp({ error: 'reserved id' }, 400);
    const log = await store.get(id, { type: 'json' });
    if (!log) return jsonResp({ error: 'not found' }, 404);

    const body = await req.json().catch(() => ({}));
    const action = body && body.action;
    if (action !== 'approve' && action !== 'reject') {
      return jsonResp({ error: 'action must be "approve" or "reject"' }, 400);
    }
    const reason = (body.reason || '').slice(0, 500);
    const now = new Date().toISOString();
    log.status = action === 'approve' ? 'approved' : 'rejected';
    log.moderatedBy = user.email;
    log.moderatedAt = now;
    log.moderationReason = reason || null;
    log.updatedAt = now;
    await store.set(id, JSON.stringify(log));

    // Notify the uploader fire-and-forget. Skip if the upload was authored
    // by the legacy-auto-approve synthetic owner — that's not a real inbox.
    if (log.email && !log.email.startsWith('_legacy_corpus@')) {
      const tpl = action === 'approve' ? logApprovedEmail(log) : logRejectedEmail(log, reason);
      sendEmail({ to: log.email, ...tpl })
        .catch(err => console.warn(`moderation-${action} email failed:`, err && err.message));
    }

    return jsonResp({ ok: true, log }, 200);
  }

  // Auth is required for writes and for the "mine" / admin-status views.
  // Plain `scope=all` reads are public so anonymous planner sessions work.
  const wantsAdminStatus =
    req.method === 'GET' &&
    ['pending', 'rejected', 'all'].includes(url.searchParams.get('status') || '');
  const needsAuth =
    req.method === 'POST' ||
    req.method === 'PATCH' ||
    req.method === 'DELETE' ||
    (req.method === 'GET' && url.searchParams.get('scope') === 'mine') ||
    wantsAdminStatus;
  const user = needsAuth ? await getUserFromRequest(req) : await getUserFromRequest(req).catch(() => null);
  if (needsAuth && !user) return jsonResp({ error: 'auth required' }, 401);
  if (wantsAdminStatus && !user.isAdmin) return jsonResp({ error: 'admin only' }, 403);

  if (url.pathname !== '/api/logs' && url.pathname !== '/api/logs/') {
    return jsonResp({ error: 'path not supported' }, 404);
  }

  if (req.method === 'POST') {
    const rl = await checkAll([
      { key: `logs-post:email:${user.email}`,    max: 30, windowMs: ONE_HOUR_MS },
      { key: `logs-post:ip:${clientIp(req)}`,    max: 60, windowMs: ONE_HOUR_MS },
    ]);
    if (!rl.ok) return rateLimitResponse(rl.retryAfterSec);

    let body;
    try { body = await req.json(); } catch { return jsonResp({ error: 'invalid JSON body' }, 400); }
    const err = validateLog(body);
    if (err) return jsonResp({ error: err }, 400);

    const contributorName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email;
    const now = new Date().toISOString();
    const id = makeLogId();
    const log = {
      id,
      email: user.email,
      contributorName,
      dep: body.dep,
      dest: body.dest,
      via: body.via,
      altsFt: body.altsFt || [],
      source: (body.source || 'PLOG').slice(0, 200),
      note: (body.note || '').slice(0, 500),
      // Metadata: fall back to the user's profile aircraft when the client
      // didn't supply one (typical for the contribute upload flow).
      aircraft: typeof body.aircraft === 'string' && body.aircraft.trim()
        ? body.aircraft.trim().slice(0, 120)
        : (user.aircraftType || '').slice(0, 120),
      flightDate: body.flightDate || null,
      country: deriveCountry(body.dep),
      cruiseAltFt: typeof body.cruiseAltFt === 'number' ? body.cruiseAltFt : null,
      outcome: body.outcome || null,
      atcAmendments: (body.atcAmendments || '').slice(0, 1000),
      importedAt: now,
      updatedAt: now,
      // Moderation gate: pending for ordinary users, auto-approved for admins.
      ...(user.isAdmin
        ? { status: 'approved', moderatedBy: user.email, moderatedAt: now }
        : { status: 'pending' }),
    };
    await store.set(id, JSON.stringify(log));

    // Fire-and-forget acknowledgement to the uploader. Skipped for admin
    // auto-approved uploads (they'd get a "queued for review" email about
    // their own already-approved plan, which is confusing).
    if (log.status === 'pending') {
      sendEmail({ to: user.email, ...uploadAckEmail(log) })
        .catch(err => console.warn('upload-ack email failed:', err && err.message));
    }

    return jsonResp({ ok: true, log }, 200);
  }

  if (req.method === 'PATCH') {
    const rl = await checkAll([
      { key: `logs-patch:email:${user.email}`,  max: 60, windowMs: ONE_HOUR_MS },
    ]);
    if (!rl.ok) return rateLimitResponse(rl.retryAfterSec);

    const id = url.searchParams.get('id');
    if (!id) return jsonResp({ error: 'id query param required' }, 400);
    if (id === MIGRATION_MARKER) return jsonResp({ error: 'reserved id' }, 400);
    const log = await store.get(id, { type: 'json' });
    if (!log) return jsonResp({ error: 'not found' }, 404);
    if (log.email !== user.email && !user.isAdmin) return jsonResp({ error: 'not your log' }, 403);

    let body;
    try { body = await req.json(); } catch { return jsonResp({ error: 'invalid JSON body' }, 400); }
    const err = validateOptionalMeta(body || {});
    if (err) return jsonResp({ error: err }, 400);

    // Only the user-editable metadata is patchable. The route shape (dep,
    // dest, via, altsFt) is immutable — re-upload to change those.
    if (typeof body.aircraft === 'string') log.aircraft = body.aircraft.trim().slice(0, 120);
    if ('flightDate' in body) log.flightDate = body.flightDate || null;
    if ('cruiseAltFt' in body) log.cruiseAltFt = typeof body.cruiseAltFt === 'number' ? body.cruiseAltFt : null;
    if ('outcome' in body) log.outcome = body.outcome || null;
    if ('atcAmendments' in body) log.atcAmendments = (body.atcAmendments || '').slice(0, 1000);
    if (typeof body.note === 'string') log.note = body.note.slice(0, 500);
    log.updatedAt = new Date().toISOString();

    await store.set(id, JSON.stringify(log));
    return jsonResp({ ok: true, log }, 200);
  }

  if (req.method === 'GET') {
    const id = url.searchParams.get('id');
    if (id) {
      if (id === MIGRATION_MARKER) return jsonResp({ error: 'not found' }, 404);
      const log = await store.get(id, { type: 'json' });
      if (!log) return jsonResp({ error: 'not found' }, 404);
      return jsonResp({ log }, 200);
    }
    const scope = url.searchParams.get('scope') || 'all';
    const statusParam = url.searchParams.get('status') || '';
    const { blobs } = await store.list();
    const logs = await Promise.all(
      blobs
        .filter(b => b.key !== MIGRATION_MARKER)
        .map(b => store.get(b.key, { type: 'json' }))
    );
    let filtered = logs.filter(Boolean);

    if (scope === 'mine') {
      // Owners see all their entries regardless of moderation state — that's
      // how they discover that an upload is still pending.
      filtered = filtered.filter(l => l.email === user.email);
    } else if (statusParam === 'all') {
      // Admin: every entry. (Auth + isAdmin already enforced above.)
    } else if (VALID_STATUS.includes(statusParam)) {
      // Admin can also request just one status (pending|approved|rejected).
      filtered = filtered.filter(l => (l.status || 'approved') === statusParam);
    } else {
      // Public default: only approved entries are part of the live corpus.
      // (Pre-moderation legacy entries without a status are treated as approved.)
      filtered = filtered.filter(l => (l.status || 'approved') === 'approved');
    }

    filtered.sort((a, b) => (b.importedAt || '').localeCompare(a.importedAt || ''));
    return jsonResp({ logs: filtered, scope, status: statusParam || null, total: filtered.length }, 200);
  }

  if (req.method === 'DELETE') {
    const id = url.searchParams.get('id');
    if (!id) return jsonResp({ error: 'id query param required' }, 400);
    if (id === MIGRATION_MARKER) return jsonResp({ error: 'reserved id' }, 400);
    const log = await store.get(id, { type: 'json' });
    if (!log) return jsonResp({ error: 'not found' }, 404);
    if (log.email !== user.email && !user.isAdmin) return jsonResp({ error: 'not your log' }, 403);
    await store.delete(id);
    return jsonResp({ ok: true, removed: log }, 200);
  }

  return jsonResp({ error: 'method not supported' }, 405);
};

export const config = { path: ['/api/logs', '/api/logs/*'] };

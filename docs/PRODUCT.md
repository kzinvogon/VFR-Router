# VFR Router — Product Doc

**Production:** <https://vfr-router.netlify.app/>

VFR Router is an open European VFR (Visual Flight Rules) routing intelligence engine. It plans light-aircraft routes that respect published VFR procedures — not just shortest-distance paths around airspace polygons. The system learns from every pilot's uploaded flight log and treats that corpus as the primary source of truth; airspace, AIP, and NOTAM data is secondary, used to enrich and validate.

---

## 1. North-star vision

A planner that:

1. **Ingests national AIPs** (ENR sections) into structured per-country rule sets — VFR minima, flight-level caps, civil-VFR prohibited CTRs, special-use classes — refreshed every AIRAC cycle.
2. **Builds a real airspace graph** — nodes are waypoints / VFR sectors / TMA entry-exit points, edges are legal transits with their constraints (class, altitude band, frequency).
3. **Validates routes** against the graph + AIP + NOTAMs, emitting structured violations any external tool can consume.
4. **Interprets NOTAMs** — LLM-assisted parsing of ICAO Q-code shorthand into graph deltas for the validity window.
5. **AI-assisted routing** over the corpus — direct match where possible, inferential mining where not.
6. **Eurocontrol-compatible** — export computed routes as IFPS FPL; ingest filed FPLs and explain rejections.
7. **Exports to existing ecosystems** — SkyDemon `.flightplan`, ForeFlight FPL, Garmin Pilot GFP, GPX, KML; anonymised corpus export for researchers.

The rungs unlock each other. Skipping one is expensive — NOTAM interpretation is meaningless without airspace graphing to apply deltas to; AI assist without a growing corpus has nothing to learn from.

Today, rungs **5 (direct match)** and parts of **3 (validation)** are live. The rest is roadmap. Country-by-country expansion: Spain is the home base, France is next — don't try to do all of Europe at once.

---

## 2. Architecture: corpus-first

A\* minimises distance + airspace penalty, but published VFR procedures (Echo arrival into Córdoba, mandatory corridors over Mallorca, VFR sectors for TMA transit) are not "shortest path." A pilot-built SkyDemon route encodes that procedural knowledge. The router treats pilot waypoints + altitudes as ground truth. A\* is the last-resort fallback.

### The two route-source layers

`VALIDATED_ROUTES` is built from two sources, last-write-wins per `(dep, dest)`:

1. **Baked** — `kb/es.json` `validatedRoutes[]`. Hand-curated, ships in the deploy. Stable curated truth (currently LEMU→LEBA, LEMU→LESL).
2. **Corpus** — every uploaded pilot log, served from `GET /api/logs?scope=all`. Backed by the `vfr-logs` Netlify Blob store, one key per log. Every authenticated upload joins the corpus immediately and is visible to every visitor (signed-in or not) + consumed by the router.

Each route is tagged `_layer: 'baked' | 'corpus' | 'corpus(yours)'` for the `CORPUS MATCH [layer]` log line.

There is **no private-vs-shared split**. Uploads are centralised, global, and consumed by every plan. Ownership is recorded (`email`, `contributorName`) but is used only for the contribute-page "Mine" filter and the per-row "YOU" badge. Never re-introduce a per-user-private upload path — uploads are global by design.

### `/api/corpus` back-compat shim

The legacy `/api/corpus` endpoint is a read-only adapter over `vfr-logs`, returning the old `items[]` shape so any cached integrations keep working. `POST`/`DELETE` there return `410 Gone` pointing at `/api/logs`. The original `vfr-corpus/index` blob's contents auto-migrate into `vfr-logs` on first read (synthetic owner `_legacy_corpus@vfr-router`, marker `_corpus_migrated` prevents re-running).

### `via[]` entry schema — three forms

- `string` → KB lookup by `name` in `NAMED_FIXES`
- `{ lat, lon }` → raw coordinate turn point (unnamed)
- `{ name, lat?, lon? }` → named with optional coords (back-computed from the prior waypoint + leg track/distance if absent; flagged `_backComputed: true`)

### Conflict-warning contract

When the planner uses a corpus route:

- **Terrain MSA pass NEVER overrides `pick.fromCorpus` altitudes.** Sets `pick.msaConflict = true` if `level < MSA`, but the level itself is untouched.
- **Airspace busts at corpus altitude emit `warn`, not `err`:** `LEG N CORPUS: corpus altitude conflicts with current airspace — busts X. Source: pilot log; verify against current AIRAC/NOTAM`. The pilot's plan isn't blamed — the data is questioned.
- **Special-use airspaces** (`ALWAYS_LATERAL_TYPE`) bypass the `isFullSandwich` filter even on corpus paths, so a clearly-busting corpus route still surfaces the warning.

Pilot logs are ground truth. The router never silently overwrites pilot altitudes; conflicts surface as auditable warnings.

---

## 3. Log entry schema

Each entry in `vfr-logs`:

**Route (immutable after upload — re-upload to change):**
- `dep`, `dest` — 4-letter ICAO
- `via[]` — array of waypoint entries (see schema above)
- `altsFt[]` — per-leg altitudes in feet, `null` allowed

**Ownership:**
- `email` — owner, populated from the authenticated session
- `contributorName` — display name, defaults to first + last name

**Flight metadata (editable post-upload via `PATCH /api/logs?id=...`):**
- `aircraft` — registration / type (e.g. `EC-XYZ / SR22`), pre-filled from `user.aircraftType`
- `flightDate` — `YYYY-MM-DD`, the date flown (or planned for); distinct from `importedAt`
- `country` — ISO-2 code, auto-derived in `logs.js` from the dep ICAO prefix via the `ICAO_COUNTRY` map (Europe-focused; `'??'` when unknown)
- `cruiseAltFt` — planned cruise altitude
- `outcome` — one of `planned | accepted | rejected | amended`, or `null`
- `atcAmendments` — free-text description of ATC's changes. **Gold for AI assist** — encodes the delta between filed and flown.

**Provenance:**
- `source`, `note`, `importedAt`, `updatedAt`

Validation lives in `validateLog` / `validateOptionalMeta` in `netlify/functions/logs.js`.

---

## 4. Routing philosophy: hard-avoid vs transit-with-clearance

"Legal VFR" has two tiers. The router must not conflate them.

### Hard-avoid (router detours around)

- **Class A** — VFR forbidden by AIP ENR 1.2 / SERA.5005
- **Class B** — clearance impractical for GA
- **Prohibited areas** — always
- **Active Restricted / Danger / TSA / TRA / MATZ / ALERT / WARNING** — user-option controlled, often NOTAM-scheduled
- **KB `hardAvoid` rules** — CTR MADRID (civil VFR prohibited per AIP ENR 6.5-10), LFPG Charles de Gaulle, LFPO Orly (civil VFR not accepted)

`AVOID_ICAO_CLASS = {'A','B'}`, `AVOID_TYPE` defaults to `{'PROHIBITED'}` plus user-optioned danger/restricted/military. **Never** add C/D/E classes or `TMA/CTR/CTA/MCTR` types to the blanket default. CTR hard-avoid is per-KB-rule only, name-matched.

### Transit with clearance (router flies through, pilot log annotates)

- **Class C / D / E TMA / CTR / CTA / MCTR** — standard VFR practice is to request transit clearance from Approach on the published frequency. ATC almost always grants it. Real pilot plans treat these as routine.
- **Example:** LEMU → LEAS transits Valencia VFR Sectors (120.100), Madrid TMA (118.400), Asturias APP (118.150) — all Class D, all transited in the real pilot's plan.

**The failure mode to avoid:** detouring around every Class D in Spain produces 500+ nm monstrosities for routes pilots fly direct in ~400 nm via central Spain with ATC on 120.xxx. The router's earlier "route around everything controlled" behavior was wrong.

`legTransitCrossings()` finds Class C/D/E TMA/CTR/CTA crossings at the picked altitude and emits `info` warnings — "transits X (D), 3500-FL145 — request clearance en route." These do **not** trigger re-routing. Only busts surviving in `leg.pick.busts` (Class A, prohibited, or KB-hard-avoid) emit `err`.

### Never

Never output "bust + request clearance" for forbidden airspace. Either output an around-route or a corridor-route — never instruct the pilot to violate.

---

## 5. VFR corridors (transit sectors)

OpenAIP airspace type `32` / `VFR_SECTOR` represents AIP-published transit corridors that ATC expects VFR traffic to use when crossing busy TMAs (Barcelona VFR Sectors SFC-3500 ft, Côte d'Azur coastal transits, Mallorca corridors, etc.). Requesting TMA clearance at 9,500 ft may be refused; the published VFR corridor at lower altitude is the standard routing.

In the data:
- VFR sectors are in `SKIP_TYPE` (not treated as obstacles) and **not** in `AVOID_TYPE` (not routed around)
- Detected per leg via `legVfrSectorsCrossed(a, b, allItems)` — searches all fetched items, not band-filtered
- Always surfaced in the Pilot Log notes + Warnings panel per leg
- **Escalate severity** when the leg's chosen altitude busts a TMA/CTR AND a VFR sector below it is available — the pilot should consider the corridor instead of requesting clearance

Future improvement: integrate OpenAIP `/reporting-points` so corridor entry/exit points become A\* nodes — the planner can then actively route via the corridor rather than just note it.

---

## 6. Country-specific airspace rules

### Spain — AIP ENR 1.2

Source: ENAIRE AIP España ENR 1.2 "Reglas de Vuelo Visual" (2021/2025 amendments).

**Hard rules:**

1. **Class A is forbidden to VFR.** AIP explicit: "VMC minima in class A airspace are included for guidance to pilots and do not imply acceptance of VFR flights in class A airspace." Router must always route around Class A polygons, never pick an altitude inside one.
2. **Maximum VFR flight level: FL195.** User-input ceiling capped/warned at FL195.
3. **Minimum altitudes** (except take-off/landing):
   - Over populated areas: ≥1000 ft above highest obstacle within 600 m.
   - Elsewhere: ≥500 ft above ground/water/obstacle within 150 m.
   - Router default `pilotMsaAgl = 1000 ft AGL` respects the populated-area rule; leave as min.
4. **CTR access for VFR:** ceiling ≥1500 ft and ground visibility ≥5 km. Special VFR clearance can relax these.
5. **Madrid CTR (ENR 6.5):** civil VFR flights **prohibited** — only Spanish military aircraft to/from MoD facilities. Madrid-Barajas does not accept VFR traffic. Treat CTR MADRID as absolute hard-avoid for civil VFR.

Spain publishes per-TMA VFR reporting points in ENR 6.x — these are the AIP-sanctioned transit points through TMA/CTA.

Night VFR / OVFR has separate rules (ceiling ≥1500 ft, etc.) and is not currently handled.

### France — AIP SIA

Source: AIP France (<sia.aviation-civile.gouv.fr>) + domain guidance 2026-04-23.

**Hard-avoid (civil VFR forbidden):**
- **LFPG** Paris Charles de Gaulle — civil VFR not accepted. KB match: `nameContains: ['PARIS CHARLES', 'CHARLES DE GAULLE', 'LFPG', 'ROISSY']`.
- **LFPO** Paris Orly — civil VFR not accepted outside published routes (narrow military/special). KB match: `nameContains: ['PARIS ORLY', 'LFPO', 'ORLY']`.

**VFR-accepted via published corridor — do NOT hard-avoid:**
- **LFMN** Nice Côte d'Azur — published VFR coastal corridors (*cheminements côtiers*). Westbound and eastbound at separate altitudes, named reporting points (CAGNES, CAP D'ANTIBES, CAP FERRAT). Hard-avoiding LFMN would break the entire Côte d'Azur.
- **LFML** Marseille Provence — similar corridor pattern.

**The distinction matters:** Class D alone is not enough signal. Some Class D CTRs refuse civil VFR (CDG, Orly); others publish corridors VFR traffic is expected to use (Nice, Marseille, Barcelona). The KB encodes the former as `hardAvoid` and the latter as `pendingCorridors` awaiting reporting-point ingestion.

When wiring a new French airport into `kb/fr.json`, **default to NOT adding a `hardAvoid` rule** — only add one with documented AIP AD 2.\<ICAO\> evidence that civil VFR is prohibited.

**AIP ingestion priority (France):**
1. `LF_AD_2_LFMN_VAC_*.pdf` — Nice reporting points (highest user impact)
2. `LF_AD_2_LFML_VAC_*.pdf` — Marseille reporting points
3. `LF_ENR_6_*.pdf` — per-TMA VFR transit charts (Paris region, Lyon, Toulouse, Bordeaux)

---

## 7. AI-assisted routing (planned)

**Goal:** the inferential path. When dep+dest exists in the corpus we use it verbatim — already shipped. When it doesn't, today the planner falls back to pure A\* + airspace penalties, discarding the corpus entirely. The AI step closes that gap.

**Example:** pilot A flew LEMD→LEMR using a Madrid TMA VFR sector. Pilot B planning LEMD→LEZG through the same TMA should be offered that sector as a suggested transit — even though their dep/dest pair never appears in the corpus.

**Build plan:**

1. **Retrieval.** Before A\* runs, given `(dep, dest, candidate corridor, intersected airspaces)`, retrieve corpus entries whose route passes through any of those airspaces or within ~25 nm of the candidate corridor. Cheap: scan `VALIDATED_ROUTES` once with a bounding-box check per leg. No vector DB.
2. **Compact prompt to Anthropic via `/api/anthropic`.** Send the candidate route, the airspaces it crosses, and the retrieved corpus entries (just `dep / dest / via[] / altsFt`). Ask for structured JSON: `{ suggestedWaypoints: [{name, lat, lon, reason, sourceLogId}], suggestedAltitudes: [...], warnings: [...] }`. The `reason` field is one sentence the pilot can audit ("Pilot X transited Madrid TMA via VFR_SECTOR_TRES_CANTOS in log l_xyz on 2026-04-12").
3. **Merge, don't replace.** AI suggestions become *hints* fed back into A\* (cost adjustments, candidate waypoints), not authoritative substitutions. Direct corpus matches still bypass A\* entirely.
4. **Surface provenance.** Every AI-suggested waypoint must link back to the corpus entry it was inferred from, visible in the `LEG N` log lines. The pilot has to be able to audit the suggestion against the actual upload.

**Constraints:**
- Must not mutate corpus pick altitudes — the conflict-warning contract still holds.
- Must not invent waypoints not present in the corpus or `NAMED_FIXES`. Every suggestion cites a real log id or a real named fix.
- Must not run on every plan. Skip the AI step entirely if a direct corpus match exists; only invoke when A\* would otherwise be the sole source.

**Open design questions:**
- **Caching:** AI suggestions for `(dep, dest, AIRAC)` tuples cacheable in a `vfr-ai-suggestions` blob store keyed by request hash.
- **Failure mode:** if `/api/anthropic` is down or rate-limited, fall back transparently to pure A\* — no user-visible error unless explicitly invoked.
- **UI:** likely a "Why these waypoints?" inline expander on the plan summary showing the corpus entries that informed each AI suggestion.

**Status:** not yet built. The corpus collapse (one unified `vfr-logs` store, `/api/logs?scope=all`) is the precondition; the data shape needed for retrieval is now in place. Build sits behind moderation work since the AI consumes whatever is in the corpus.

---

## 8. API + storage

### Pages

- `/` — router (planner)
- `/contribute.html` — PLOG upload + corpus browser (All / Mine filter)
- `/login.html`, `/register.html`, `/profile.html`, `/plans.html`, `/admin.html`
- `/trainer.html` — VFR corpus trainer (Anthropic-backed; legacy)

### Functions (`netlify-deploy/netlify/functions/`)

| Endpoint | Purpose |
|---|---|
| `/api/airspaces` | OpenAIP airspace proxy (env `OPENAIP_API_KEY`) |
| `/api/airports` | OpenAIP airports proxy (same key) |
| `/api/elevation` | OpenTopoData SRTM30m proxy (no key) |
| `/api/anthropic` | Anthropic Messages proxy (env `ANTHROPIC_API_KEY`) |
| `/api/logs` | Unified pilot corpus — `GET` (default `scope=all`, returns **approved only**, anonymous OK), `GET?scope=mine` (auth, returns caller's logs at any status), `GET?status=pending\|rejected\|all` (admin only), `POST` (auth, rate-limited, status=pending unless admin), `PATCH?id=…` (owner/admin, rate-limited), `DELETE?id=…` (owner/admin) |
| `/api/logs/<id>/moderate` | Admin only. `POST { action: 'approve' \| 'reject', reason? }` flips `status`. |
| `/api/corpus` | Read-only back-compat shim over approved `/api/logs`. POST/DELETE return `410`. |
| `/api/auth/*` | `register`, `request-code`, `verify-code`, `me`, `logout`, `profile`, `users` |
| `/api/plans/*` | `POST` save, `GET` (`scope=mine|all`), `DELETE` |

`_lib/auth-helpers.js` is a shared module — subdirectory, so Netlify doesn't deploy it as a separate function.

### Netlify Blobs stores

| Store | Purpose |
|---|---|
| `vfr-logs` | Unified pilot corpus. Each log keyed `l_<base36ts>_<rand>`. Carries `status` (`pending`/`approved`/`rejected`). Reserved key `_corpus_migrated` is the legacy-import marker. |
| `vfr-corpus` | **LEGACY** — original shared-routes index. Auto-migrated into `vfr-logs` on first read. Safe to delete the `index` key once migration is confirmed. |
| `vfr-users` | Keyed by lowercased email; user record `{firstName, lastName, callSign, aircraftType, defaultDep, isAdmin, …}` |
| `vfr-sessions` | Keyed by session token; `{email, expiresAt}` |
| `vfr-codes` | Keyed by email; pending 6-digit code (10-min TTL, 5 attempts) |
| `vfr-plans` | Keyed by plan id `p_<base36ts>_<rand>`; full plan blob |
| `vfr-ratelimit` | Fixed-window counters keyed `<endpoint>:<identifier>`. Used by `_lib/rate-limit.js`. Safe to wipe — windows just reset. |

All `getStore` calls use `consistency: 'strong'` to avoid read-after-write race.

### Cloud-only storage rule

User-owned data — flight logs, saved plans, profile — must live server-side in Netlify Blobs. **Never** persist this kind of data in localStorage. localStorage is OK only for genuinely ephemeral device-specific UI state (theme, airspace-overlay toggle, search input). Flight logs in particular are centralised and global; there is no "share to publish" step — uploading IS contributing.

---

## 9. Deployment

**Production:** <https://vfr-router.netlify.app/>. Netlify site `vfr-router`. No auto-deploy from git — manual deploys only.

**Deploy command:**
```
netlify deploy --prod --dir . --functions netlify/functions
```
Run from `/Users/davidhamilton/Dev/VFR-Router/netlify-deploy/`.

**Env vars** (Netlify dashboard → Site → Configuration → Environment variables):
- `OPENAIP_API_KEY` — required
- `ANTHROPIC_API_KEY` — required for trainer + AI assist
- `RESEND_API_KEY` — required for `auth/request-code`. Without it the endpoint fails closed with 503 — codes are never returned in the response.
- `EMAIL_FROM` — sender address (default `VFR Router <onboarding@resend.dev>`). Set to a verified domain for prod.
- `ADMIN_EMAILS` — comma-separated emails granted admin on registration. If unset, the first registered user auto-promotes.

**CLI ops:**
- `netlify blobs:list <store>` — list keys (display replaces `+` with space, deceptive)
- `netlify blobs:get <store> "<key>"` — fetch one value
- `netlify blobs:delete <store> "<key>"` — delete an entry

**Rate-limit gotcha:** Netlify deploy rate-limits aggressively. A 90 s backoff between `netlify deploy --prod` calls is NOT enough; 5 min is more reliable. Batch changes per deploy.

---

## 10. Production-readiness gaps

The deployed system works end-to-end but several pieces are deliberately POC-quality. The three rollout-blocking gaps are now closed; remaining items are incremental.

### Closed (2026-05-13)

- **Email delivery.** `auth/request-code` now sends via Resend (`_lib/email.js`). Requires `RESEND_API_KEY`; fails closed with 503 if missing. Codes are never returned in the response. UI on `/login.html` no longer renders a dev code.
- **Corpus moderation.** New `status: 'pending' | 'approved' | 'rejected'` on every log. New uploads land `pending` (admin uploads + legacy-migrated entries auto-approve). `GET /api/logs?scope=all` returns approved-only — the planner only consumes approved data. Admin moderation queue at `/admin.html` with approve/reject + reason. Owners see their pending uploads on the contribute page's "Mine" tab.
- **Rate limiting.** `_lib/rate-limit.js` with Blob-backed fixed-window counters in `vfr-ratelimit`. Applied to `request-code` (5/email/hr, 20/IP/hr), `verify-code` (10/email/hr, 30/IP/hr), `logs POST` (30/user/hr, 60/IP/hr), `logs PATCH` (60/user/hr). 429 responses include `retry-after`.

### Still open

1. **Magic link not implemented.** Only the 6-digit code flow is built. Same backend (codes store) can serve both — generate a token + URL alongside the digits.
2. **Admin user-management is read-only.** `/admin.html` lists users + plans but offers no delete/promote/demote/disable controls. Endpoints needed: `DELETE /api/auth/users?email=…`, `PUT /api/auth/users?email=…`.
3. **Two-file divergence.** `vfr-router.html` (local dev source) and `netlify-deploy/index.html` (deployed) are no longer byte-identical. `netlify-deploy/index.html` is the authoritative production version.
4. **Router page weight.** ~2700 lines in one HTML file. A real productionisation pass would extract JS modules and add a build step.
5. **Rate limiter is best-effort.** Concurrent requests can race the read+write in `vfr-ratelimit` and undercount by 1-2. Fine for abuse throttling; if a harder cap is needed, move to Netlify Edge Functions.

---

## 11. Recommended next deliverable

Two candidates:

- **Smallest concrete next:** AI assist v1. The data shape is ready, the design is captured, the retrieval step is cheap. Ship as `/api/plan-assist`.
- **Most valuable next:** moderation. Without it, AI assist amplifies bad data and any external `/api/export` becomes a liability.

Order suggestion: moderation → AI assist v1 → AIP ingestion for Spain → route-validation endpoint → NOTAM → Eurocontrol IFPS → ecosystem export.

// Best-effort per-key rate limiter backed by a Netlify Blob store. Fixed-
// window counter — a window starts on the first request for a key and resets
// once `windowMs` has elapsed. Concurrent requests can race the read+write,
// so this can undercount by 1-2 in burst conditions; that's acceptable for
// abuse throttling but unfit as a security barrier on its own.
//
// Store: `vfr-ratelimit`. Keys are caller-defined, conventionally
// `<endpoint>:<identifier>` (e.g. `request-code:ip:1.2.3.4`).

import { getStore } from '@netlify/blobs';

const STORE = 'vfr-ratelimit';

export async function checkRateLimit(key, { max, windowMs }) {
  const store = getStore({ name: STORE, consistency: 'strong' });
  const now = Date.now();
  const entry = await store.get(key, { type: 'json' });
  let count, windowStart;
  if (!entry || now - entry.windowStart > windowMs) {
    count = 1;
    windowStart = now;
  } else {
    count = entry.count + 1;
    windowStart = entry.windowStart;
  }
  await store.set(key, JSON.stringify({ count, windowStart }));
  if (count > max) {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000)) };
  }
  return { ok: true, remaining: Math.max(0, max - count) };
}

// Run several rate-limit buckets and fail closed on the first miss. Returns
// the failed result (with retryAfterSec) or { ok: true } when all pass.
export async function checkAll(checks) {
  for (const { key, max, windowMs } of checks) {
    const r = await checkRateLimit(key, { max, windowMs });
    if (!r.ok) return r;
  }
  return { ok: true };
}

export function clientIp(req) {
  return req.headers.get('x-nf-client-connection-ip')
      || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim()
      || 'unknown';
}

export function rateLimitResponse(retryAfterSec) {
  return new Response(
    JSON.stringify({ error: 'rate limit exceeded — try again later', retryAfterSec }),
    {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'retry-after': String(retryAfterSec),
      },
    },
  );
}

export const ONE_HOUR_MS = 60 * 60 * 1000;

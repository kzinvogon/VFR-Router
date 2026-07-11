// /api/auth/* — user registration, passwordless login (6-digit code), profile
// management, and admin user listing. Backed by Netlify Blobs. Sessions are
// HTTP-only cookies; codes have a 10-minute TTL; bcrypt is unnecessary since
// no passwords are stored.
//
// Email delivery: request-code generates a code and sends it via Resend
// (RESEND_API_KEY). If the env var is missing or the send fails, the endpoint
// fails closed with HTTP 503 — it does NOT leak the code in the response.

import { getStore } from '@netlify/blobs';
import {
  USERS, SESSIONS, CODES,
  CODE_TTL_MINUTES, SESSION_TTL_DAYS,
  jsonResp, makeSessionToken, make6DigitCode,
  isAdminEmail, VALID_EMAIL,
  getUserFromRequest, setCookieHeaders, clearCookieHeaders, publicUser,
} from './_lib/auth-helpers.js';
import { sendEmail, loginCodeEmail } from './_lib/email.js';
import { checkAll, clientIp, rateLimitResponse, ONE_HOUR_MS } from './_lib/rate-limit.js';

export default async (req) => {
  const url = new URL(req.url);
  const action = url.pathname.replace(/^\/api\/auth\/?/, '').replace(/\/$/, '');

  // ── REGISTER ────────────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'register') {
    const body = await req.json().catch(() => null);
    if (!body) return jsonResp({ error: 'invalid JSON body' }, 400);
    const email = (body.email || '').toLowerCase().trim();
    const firstName = (body.firstName || '').trim();
    const lastName = (body.lastName || '').trim();
    const callSign = (body.callSign || '').trim();
    const aircraftType = (body.aircraftType || '').trim();

    if (!VALID_EMAIL.test(email)) return jsonResp({ error: 'invalid email address' }, 400);
    if (!firstName) return jsonResp({ error: 'first name is required' }, 400);
    if (!lastName)  return jsonResp({ error: 'last name is required' }, 400);
    if (firstName.length > 50 || lastName.length > 50) return jsonResp({ error: 'name too long' }, 400);
    if (callSign.length > 20) return jsonResp({ error: 'call sign too long' }, 400);
    if (aircraftType.length > 30) return jsonResp({ error: 'aircraft type too long' }, 400);

    const userStore = getStore({ name: USERS, consistency: 'strong' });
    const existing = await userStore.get(email, { type: 'json' });
    if (existing) return jsonResp({ error: 'an account already exists for this email' }, 409);

    // Bootstrap: if no admin is configured via env and this is the very
    // first registered user, promote them. Otherwise check env admin list.
    let isAdmin = isAdminEmail(email);
    if (!isAdmin) {
      const { blobs } = await userStore.list();
      if (blobs.length === 0) isAdmin = true;
    }

    const user = {
      email, firstName, lastName, callSign, aircraftType,
      defaultDep: '',
      isAdmin,
      createdAt: new Date().toISOString(),
    };
    await userStore.set(email, JSON.stringify(user));
    return jsonResp({ ok: true, user: publicUser(user) }, 200);
  }

  // ── REQUEST CODE ────────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'request-code') {
    const body = await req.json().catch(() => null);
    const email = (body?.email || '').toLowerCase().trim();
    if (!VALID_EMAIL.test(email)) return jsonResp({ error: 'invalid email address' }, 400);

    // Rate limit: stops both targeted spam (per email) and broad abuse (per IP).
    const rl = await checkAll([
      { key: `request-code:email:${email}`, max: 5,  windowMs: ONE_HOUR_MS },
      { key: `request-code:ip:${clientIp(req)}`, max: 20, windowMs: ONE_HOUR_MS },
    ]);
    if (!rl.ok) return rateLimitResponse(rl.retryAfterSec);

    const userStore = getStore({ name: USERS, consistency: 'strong' });
    const user = await userStore.get(email, { type: 'json' });
    if (!user) return jsonResp({ error: 'no account with that email — register first' }, 404);

    const code = make6DigitCode();
    const codeStore = getStore({ name: CODES, consistency: 'strong' });
    await codeStore.set(email, JSON.stringify({
      code,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000).toISOString(),
      attempts: 0,
    }));

    // Send via email. Fail closed if the provider isn't configured or the
    // send fails — never return the code in the response.
    const mail = await sendEmail({ to: email, ...loginCodeEmail(code, CODE_TTL_MINUTES) });
    if (!mail.ok) {
      await codeStore.delete(email);
      return jsonResp({ error: `could not send code: ${mail.error}` }, 503);
    }
    return jsonResp({
      ok: true,
      message: `Code sent — check your inbox at ${email} (valid ${CODE_TTL_MINUTES} min).`,
    });
  }

  // ── VERIFY CODE ─────────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'verify-code') {
    const body = await req.json().catch(() => null);
    const email = (body?.email || '').toLowerCase().trim();
    const code = (body?.code || '').trim();
    if (!VALID_EMAIL.test(email)) return jsonResp({ error: 'invalid email' }, 400);
    if (!/^\d{6}$/.test(code))    return jsonResp({ error: 'code must be 6 digits' }, 400);

    // Rate limit on top of the existing 5-attempt-per-code cap, so attackers
    // can't request 100 fresh codes and burn 5 guesses on each.
    const rl = await checkAll([
      { key: `verify-code:email:${email}`,        max: 10, windowMs: ONE_HOUR_MS },
      { key: `verify-code:ip:${clientIp(req)}`,   max: 30, windowMs: ONE_HOUR_MS },
    ]);
    if (!rl.ok) return rateLimitResponse(rl.retryAfterSec);

    const codeStore = getStore({ name: CODES, consistency: 'strong' });
    const entry = await codeStore.get(email, { type: 'json' });
    if (!entry) return jsonResp({ error: 'no pending code — request one first' }, 401);
    if (new Date(entry.expiresAt) < new Date()) {
      await codeStore.delete(email);
      return jsonResp({ error: 'code expired — request a new one' }, 401);
    }
    if (entry.attempts >= 5) {
      await codeStore.delete(email);
      return jsonResp({ error: 'too many wrong attempts — request a new code' }, 401);
    }
    if (entry.code !== code) {
      entry.attempts++;
      await codeStore.set(email, JSON.stringify(entry));
      return jsonResp({ error: 'incorrect code', attemptsRemaining: 5 - entry.attempts }, 401);
    }
    // Match — consume code, issue session.
    await codeStore.delete(email);
    const userStore = getStore({ name: USERS, consistency: 'strong' });
    const user = await userStore.get(email, { type: 'json' });
    if (!user) return jsonResp({ error: 'user no longer exists' }, 404);

    const token = makeSessionToken();
    const sessionStore = getStore({ name: SESSIONS, consistency: 'strong' });
    await sessionStore.set(token, JSON.stringify({
      email,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    }));
    return jsonResp({ ok: true, user: publicUser(user) }, 200, setCookieHeaders(token));
  }

  // ── ME ──────────────────────────────────────────────────────────────────
  if (req.method === 'GET' && action === 'me') {
    const user = await getUserFromRequest(req);
    return jsonResp({ user: publicUser(user) }, 200);
  }

  // ── LOGOUT ──────────────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'logout') {
    const user = await getUserFromRequest(req);
    if (user?._sessionToken) {
      const sessionStore = getStore({ name: SESSIONS, consistency: 'strong' });
      await sessionStore.delete(user._sessionToken);
    }
    return jsonResp({ ok: true }, 200, clearCookieHeaders());
  }

  // ── PROFILE UPDATE ──────────────────────────────────────────────────────
  if (req.method === 'PUT' && action === 'profile') {
    const user = await getUserFromRequest(req);
    if (!user) return jsonResp({ error: 'auth required' }, 401);
    const body = await req.json().catch(() => null);
    if (!body) return jsonResp({ error: 'invalid body' }, 400);

    const updated = {
      ...user,
      firstName:    (body.firstName    ?? user.firstName).trim(),
      lastName:     (body.lastName     ?? user.lastName).trim(),
      callSign:     (body.callSign     ?? user.callSign).trim(),
      aircraftType: (body.aircraftType ?? user.aircraftType).trim(),
      defaultDep:   (body.defaultDep   ?? user.defaultDep).trim().toUpperCase(),
    };
    delete updated._sessionToken;
    if (!updated.firstName) return jsonResp({ error: 'first name is required' }, 400);
    if (!updated.lastName)  return jsonResp({ error: 'last name is required' }, 400);
    if (updated.defaultDep && !/^[A-Z]{0,4}$/.test(updated.defaultDep)) {
      return jsonResp({ error: 'default departure must be a 4-letter ICAO' }, 400);
    }
    const userStore = getStore({ name: USERS, consistency: 'strong' });
    await userStore.set(user.email, JSON.stringify(updated));
    return jsonResp({ ok: true, user: publicUser(updated) }, 200);
  }

  // ── ADMIN: LIST USERS ───────────────────────────────────────────────────
  if (req.method === 'GET' && action === 'users') {
    const user = await getUserFromRequest(req);
    if (!user || !user.isAdmin) return jsonResp({ error: 'admin only' }, 403);
    const userStore = getStore({ name: USERS, consistency: 'strong' });
    const { blobs } = await userStore.list();
    const users = await Promise.all(blobs.map(b => userStore.get(b.key, { type: 'json' })));
    return jsonResp({ users: users.filter(Boolean).map(publicUser) }, 200);
  }

  return jsonResp({ error: `unknown action: ${action}` }, 404);
};

export const config = { path: ['/api/auth', '/api/auth/*'] };

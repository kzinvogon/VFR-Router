// Shared auth helpers. Placed in a subdirectory so Netlify doesn't try to
// deploy this file as its own function — only top-level files in
// netlify/functions/ become routed endpoints.

import { getStore } from '@netlify/blobs';
import { randomBytes } from 'crypto';

export const USERS = 'vfr-users';
export const SESSIONS = 'vfr-sessions';
export const CODES = 'vfr-codes';
export const PLANS = 'vfr-plans';

export const SESSION_TTL_DAYS = 30;
export const CODE_TTL_MINUTES = 10;

export function jsonResp(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function makeSessionToken() {
  return randomBytes(24).toString('base64url');
}

export function make6DigitCode() {
  return String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
}

export function isAdminEmail(email) {
  const env = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return env.includes((email || '').toLowerCase());
}

export const VALID_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function readSessionCookie(req) {
  const cookie = req.headers.get('cookie') || '';
  const m = cookie.match(/(?:^|;\s*)vfr_session=([^;]+)/);
  return m ? m[1] : null;
}

export async function getUserFromRequest(req) {
  const token = readSessionCookie(req);
  if (!token) return null;
  const sessionStore = getStore({ name: SESSIONS, consistency: 'strong' });
  const session = await sessionStore.get(token, { type: 'json' });
  if (!session) return null;
  if (new Date(session.expiresAt) < new Date()) {
    await sessionStore.delete(token);
    return null;
  }
  const userStore = getStore({ name: USERS, consistency: 'strong' });
  const user = await userStore.get((session.email || '').toLowerCase(), { type: 'json' });
  if (!user) return null;
  return { ...user, _sessionToken: token };
}

export function setCookieHeaders(token) {
  const maxAge = SESSION_TTL_DAYS * 24 * 60 * 60;
  return {
    'set-cookie': `vfr_session=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`,
  };
}

export function clearCookieHeaders() {
  return {
    'set-cookie': `vfr_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
  };
}

// Strip sensitive/internal fields before returning a user to the client.
export function publicUser(u) {
  if (!u) return null;
  const { _sessionToken, ...rest } = u;
  return rest;
}

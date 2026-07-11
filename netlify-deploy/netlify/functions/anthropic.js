// Netlify Function: proxy browser requests to the Anthropic Messages API.
// The browser calls POST /.netlify/functions/anthropic; this handler forwards
// the body to client.messages.create() using the ANTHROPIC_API_KEY that lives
// in Netlify's environment (never shipped to the browser).
//
// Configure in the Netlify dashboard: Site → Configuration → Environment
// variables → ANTHROPIC_API_KEY.
//
// Abuse note: this endpoint is public once deployed. Anyone who knows the URL
// can spend your Anthropic quota. For a personal tool, an Origin check plus a
// simple shared secret in a header is usually enough; for anything public, add
// real auth (Netlify Identity, Auth0, Cloudflare Access, etc.).

import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

// Optional: if ALLOWED_ORIGIN is set, reject requests from other origins.
// Leave unset to allow all origins.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || null;

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), {
      status: 405,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (ALLOWED_ORIGIN) {
    const origin = req.headers.get('origin') || '';
    if (origin && origin !== ALLOWED_ORIGIN) {
      return new Response(JSON.stringify({ error: 'origin not allowed' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    }
  }

  let params;
  try {
    params = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON body' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  try {
    const message = await client.messages.create(params);
    return new Response(JSON.stringify(message), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    // Anthropic.APIError carries .status and .message; surface both so the
    // browser can show useful errors without leaking internals.
    const status = err?.status ?? 500;
    const message = err?.message ?? 'upstream error';
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }
};

export const config = { path: '/.netlify/functions/anthropic' };

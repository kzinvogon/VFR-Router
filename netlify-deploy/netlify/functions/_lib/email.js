// Email-delivery helper. Resend (https://resend.com) chosen for the simplest
// API + generous free tier. Env vars:
//   RESEND_API_KEY   — required; without it sendEmail returns ok:false
//   EMAIL_FROM       — sender address; default 'onboarding@resend.dev'
//                       (works for the first send-to-self without domain setup;
//                        replace with a verified domain for prod)
//
// Callers must fail-closed on { ok:false } — never fall back to leaking the
// secret over the response. See [[project_production_gaps]].

export async function sendEmail({ to, subject, text, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { ok: false, error: 'email service not configured (RESEND_API_KEY missing)' };
  }
  const from = process.env.EMAIL_FROM || 'VFR Router <onboarding@resend.dev>';
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ from, to, subject, text, html }),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      return { ok: false, error: `resend ${resp.status}: ${detail.slice(0, 200)}` };
    }
    const data = await resp.json().catch(() => ({}));
    return { ok: true, id: data.id || null };
  } catch (err) {
    return { ok: false, error: `email transport error: ${err.message}` };
  }
}

export function loginCodeEmail(code, ttlMinutes) {
  const subject = `VFR Router sign-in code: ${code}`;
  const text =
    `Your VFR Router sign-in code is ${code}.\n` +
    `It expires in ${ttlMinutes} minutes. If you didn't request this, ignore this email.\n`;
  const html =
    `<p>Your VFR Router sign-in code is <strong style="font-size:22px;letter-spacing:4px;font-family:monospace">${code}</strong>.</p>` +
    `<p>It expires in ${ttlMinutes} minutes. If you didn't request this, you can ignore this email.</p>`;
  return { subject, text, html };
}

// ── MODERATION NOTIFICATIONS ───────────────────────────────────────────────
// These run fire-and-forget from logs.js — the HTTP response never waits on
// email delivery, so a slow Resend call doesn't slow the upload.

// Free tier promise. When a premium tier ships, pick the SLA from user.tier
// (e.g. 48h for premium) in the caller and pass it in via the `slaText`
// override below — the template is already wired for it.
const DEFAULT_SLA_TEXT = 'We use best efforts to review submissions within 7 days.';

function planSummary(log) {
  const parts = [];
  parts.push(`Route: ${log.dep} → ${log.dest}`);
  parts.push(`Waypoints: ${(log.via || []).length}`);
  if (log.aircraft) parts.push(`Aircraft: ${log.aircraft}`);
  if (log.flightDate) parts.push(`Flight date: ${log.flightDate}`);
  if (log.cruiseAltFt) parts.push(`Cruise: ${log.cruiseAltFt} ft`);
  return parts;
}

function summaryHtml(log) {
  return `<ul style="font-family:monospace;font-size:13px;line-height:1.6">${
    planSummary(log).map(p => `<li>${p}</li>`).join('')
  }</ul>`;
}

function summaryText(log) {
  return planSummary(log).map(p => `  ${p}`).join('\n');
}

export function uploadAckEmail(log, slaText = DEFAULT_SLA_TEXT) {
  const subject = `Plan received: ${log.dep} → ${log.dest}`;
  const text =
    `Thanks — we've received your flight plan and queued it for moderator review.\n\n` +
    `${summaryText(log)}\n\n` +
    `${slaText} You'll get another email when it's been reviewed. Until then your plan is visible to you under "My plans" on the contribute page but it is not yet used by the router.\n\n` +
    `View your plans: https://vfr-router.com/contribute.html\n`;
  const html =
    `<p>Thanks — we've received your flight plan and queued it for moderator review.</p>` +
    summaryHtml(log) +
    `<p>${slaText} You'll get another email when it's been reviewed. Until then your plan is visible to you under "My plans" on the contribute page but is not yet used by the router.</p>` +
    `<p><a href="https://vfr-router.com/contribute.html">View your plans</a></p>`;
  return { subject, text, html };
}

export function logApprovedEmail(log) {
  const subject = `Plan approved: ${log.dep} → ${log.dest}`;
  const text =
    `Good news — your flight plan has been approved and is now part of the live VFR Router corpus.\n\n` +
    `${summaryText(log)}\n\n` +
    `Other pilots routing through these airspaces will now benefit from your route. Thanks for contributing.\n\n` +
    `View it: https://vfr-router.com/contribute.html\n`;
  const html =
    `<p>Good news — your flight plan has been approved and is now part of the live VFR Router corpus.</p>` +
    summaryHtml(log) +
    `<p>Other pilots routing through these airspaces will now benefit from your route. Thanks for contributing.</p>` +
    `<p><a href="https://vfr-router.com/contribute.html">View it</a></p>`;
  return { subject, text, html };
}

export function logRejectedEmail(log, reason) {
  const subject = `Plan not added to corpus: ${log.dep} → ${log.dest}`;
  const reasonBlock = reason
    ? `Reason given by the moderator:\n  ${reason}\n\n`
    : `No specific reason was given.\n\n`;
  const reasonHtml = reason
    ? `<p><strong>Reason given by the moderator:</strong></p><blockquote style="border-left:3px solid #ccc;padding-left:10px;color:#666">${escapeHtml(reason)}</blockquote>`
    : `<p><em>No specific reason was given.</em></p>`;
  const text =
    `Your flight plan was reviewed but not added to the live VFR Router corpus.\n\n` +
    `${summaryText(log)}\n\n` +
    reasonBlock +
    `Your plan is still visible to you under "My plans" on the contribute page. You can edit the metadata or upload a corrected PLOG.\n\n` +
    `View your plans: https://vfr-router.com/contribute.html\n`;
  const html =
    `<p>Your flight plan was reviewed but not added to the live VFR Router corpus.</p>` +
    summaryHtml(log) +
    reasonHtml +
    `<p>Your plan is still visible to you under "My plans" on the contribute page. You can edit the metadata or upload a corrected PLOG.</p>` +
    `<p><a href="https://vfr-router.com/contribute.html">View your plans</a></p>`;
  return { subject, text, html };
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

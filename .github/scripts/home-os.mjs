// home-os.mjs — shared helpers for the scheduled email jobs. Reads the
// household Gist (the same file the app syncs to — `ortiz-home-os.json`),
// applies tombstones so deleted records never show up, and sends mail from
// the family Gmail over SMTP. No app backend: the Gist IS the store, GitHub
// Actions is the sender — exactly like send-push.mjs, but email instead of
// web-push.
import nodemailer from 'nodemailer';

const GIST_FILENAME = 'ortiz-home-os.json';

// ---------- Gist read ----------

// Fetch the household snapshot and return { data } where data is the map of
// store name -> records ({ chores: [...], agenda: [...], ... }). Throws on a
// missing config or an unreadable Gist so a misconfiguration stays visible.
export async function readSnapshot() {
  const { GIST_ID, GIST_TOKEN } = process.env;
  if (!GIST_ID || !GIST_TOKEN) {
    throw new Error(
      'Missing repo secrets GIST_ID / GIST_TOKEN. Add them under GitHub → repo ' +
      'Settings → Secrets and variables → Actions (same values as send-push.mjs uses).'
    );
  }
  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    headers: {
      Authorization: `Bearer ${GIST_TOKEN}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (!res.ok) throw new Error(`Gist ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const gist = await res.json();
  const file = gist.files && gist.files[GIST_FILENAME];
  if (!file || !file.content) {
    // The app hasn't synced yet (nobody's opened it with sync on). Not an
    // error — just nothing to report.
    return { data: {} };
  }
  const snapshot = JSON.parse(file.content);
  return { data: snapshot.data || {} };
}

// Live (non-deleted) records for a store. Mirrors the app's merge rule: a
// record is gone if a tombstone for it exists whose deletedAt is at least as
// new as the record's last edit (a newer edit resurrects it). Keeps the
// emails honest — deleted tasks/agenda items never reappear.
export function live(data, store) {
  const recs = data[store] || [];
  const dead = new Map(); // recordId -> newest deletedAt
  for (const t of data.tombstones || []) {
    if (t && t.store === store && t.recordId) {
      const prev = dead.get(t.recordId) || '';
      if ((t.deletedAt || '') > prev) dead.set(t.recordId, t.deletedAt || '');
    }
  }
  return recs.filter((r) => {
    if (!r || !r.id) return false;
    const d = dead.get(r.id);
    return !d || (r.updatedAt || '') > d;
  });
}

// ---------- dates (Arizona / America/Phoenix, no DST) ----------

// Today as YYYY-MM-DD in the family's timezone, so "this week" and "due
// today" line up with what the app shows on their phones.
export function today() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Phoenix',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// Parse a YYYY-MM-DD as local noon — never midnight — so a day-keyed string
// can't roll to the previous day on a timezone boundary (the UTC-rollover
// lesson from the app's own date handling).
export function parseDate(ymd) {
  return new Date(`${ymd}T12:00:00`);
}

export function addDays(ymd, n) {
  const d = parseDate(ymd);
  d.setDate(d.getDate() + n);
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

// "Wed, Jul 22" — matches the app's fmtDay feel.
export function fmtDay(ymd) {
  if (!ymd) return '';
  return parseDate(ymd).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

// The date of this week's Family meeting: today if today is the meeting day,
// else the next occurrence. Honors a "concluded" marker from the synced
// meetingState store (tapping "Meeting concluded" in the app advances the
// cycle early). Family meeting day defaults to Wednesday (3) — settings live
// in per-device localStorage and aren't in the Gist, so we use the app's
// default, which is also the day this job is scheduled to run.
export function familyMeetingDate(data, meetingDay = 3, base = today()) {
  const delta = (meetingDay - parseDate(base).getDay() + 7) % 7;
  const d = addDays(base, delta);
  const state = (data.meetingState || []).find((r) => r && r.id === 'family');
  const concluded = state && state.concludedCycle;
  return concluded && concluded >= d ? addDays(d, 7) : d;
}

// ---------- text helpers ----------

// Strip the app's sparing **bold** Markdown down to plain text for email.
export function plain(s) {
  return String(s || '').replace(/\*\*(.+?)\*\*/g, '$1').trim();
}

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------- mail ----------

// Whether this run should log instead of send. Parsed carefully: the Actions
// "Run workflow" button passes a boolean input as the STRING 'true' or
// 'false', and 'false' is truthy in JS — so only these exact values count as
// on. A scheduled run has DRY_RUN unset (empty) → a real send.
export function isDryRun() {
  return /^(1|true|yes|on)$/i.test((process.env.DRY_RUN || '').trim());
}

// Send from the family Gmail over SMTP using an app password (Google Account
// → Security → App passwords). GMAIL_USER defaults to the account the app is
// built around. Set DRY_RUN=1 to log the message and skip sending — handy for
// testing a workflow from the Actions "Run workflow" button before it's live.
export async function sendMail({ to, subject, text, html }) {
  // Use || (not a destructuring default) so an empty-string env var — which is
  // what an unset `${{ secrets.GMAIL_USER }}` passes — still falls back to the
  // default account instead of authing with a blank username.
  const GMAIL_USER = process.env.GMAIL_USER || 'chris.ortiz@gmail.com';
  // Google displays app passwords as "abcd efgh ijkl mnop"; strip any spaces
  // so a copy-paste-with-spaces still authenticates.
  const GMAIL_APP_PASSWORD = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
  if (isDryRun()) {
    console.log(`[DRY RUN — preview only, nothing sent]\nTo:      ${to || '(no recipient)'}\nSubject: ${subject}\n\n${text}\n`);
    return;
  }
  if (!GMAIL_APP_PASSWORD) {
    throw new Error(
      'Missing repo secret GMAIL_APP_PASSWORD. Create one at Google Account → ' +
      'Security → 2-Step Verification → App passwords, then add it under GitHub ' +
      '→ repo Settings → Secrets and variables → Actions.'
    );
  }
  if (!to) throw new Error('No recipient — set the relevant email secret.');
  const transport = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });
  const info = await transport.sendMail({
    from: `Ortiz Home OS <${GMAIL_USER}>`,
    to,
    subject,
    text,
    html,
  });
  console.log(`sent "${subject}" → ${to} (${info.messageId})`);
}

// ---------- email UI kit ----------
// A small set of composable, on-brand HTML builders so both emails read like
// part of Home OS. Everything is table-based with fully inline styles — the
// only markup email clients (Gmail, Apple Mail) render reliably; <style>
// blocks, external CSS, and inline SVG are all stripped. Palette is the app's
// own token set; the rose/maroon brand hue matches the installed app icon.
const BRAND = '#9d174d';       // matches icons/icon-192.png (rose)
const INK = '#1c2622';         // --text
const INK_2 = '#5f6e68';       // --text-2
const INK_3 = '#93a29b';       // --text-3
const HAIR = '#f0f3f1';        // hairline between rows
const FONT = "'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const APP_URL = 'https://ortizzle.github.io/ortiz-home-os/';
const APP_ICON = 'https://ortizzle.github.io/ortiz-home-os/icons/icon-192.png';

// Status chip palettes (text, background) — darkened for readable text on the
// soft fills, matching the app's --bad / --warn / --surface-2 intent.
const CHIP = {
  overdue: ['#b4231c', '#fbeceb'],
  today: ['#8a5a12', '#f8eeda'],
  soon: ['#5f6e68', '#eaf0ed'],
};
// The app's six owner colors (text, background), assigned to people by name.
const OWNERS = [
  ['#0e7490', '#cffafe'], ['#0369a1', '#e0f2fe'], ['#4338ca', '#e0e7ff'],
  ['#6d28d9', '#ede9fe'], ['#a21caf', '#fae8ff'], ['#9d174d', '#fce7f3'],
];
function ownerColors(name) {
  let hash = 0;
  for (const ch of String(name || '')) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return OWNERS[hash % OWNERS.length];
}

const pill = (fg, bg, text) =>
  `<span style="display:inline-block;font-size:11px;font-weight:700;color:${fg};background:${bg};padding:2px 9px;border-radius:999px;white-space:nowrap;vertical-align:middle;line-height:1.5;">${esc(text)}</span>`;

// A status chip (overdue / today / soon).
export function chip(text, kind = 'soon') {
  const [fg, bg] = CHIP[kind] || CHIP.soon;
  return pill(fg, bg, text);
}
// A person chip in that person's owner color.
export function ownerChip(name) {
  const [fg, bg] = ownerColors(name);
  return pill(fg, bg, name);
}

// A muted uppercase section label.
export function h(label) {
  return `<div style="font-size:12px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:${INK_3};margin:26px 0 6px;">${esc(label)}</div>`;
}
// A section label headed by a person, dotted and tinted in their owner color.
export function ownerHeading(name, count) {
  const [fg] = name === 'Unassigned' ? [INK_3] : ownerColors(name);
  return `<div style="margin:26px 0 6px;font-size:14px;font-weight:700;color:${fg};">` +
    `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${fg};margin-right:8px;vertical-align:middle;"></span>` +
    `${esc(name)}<span style="color:${INK_3};font-weight:500;"> · ${count}</span></div>`;
}

// One divided item row: bold-ish title (may carry a trailing chip), optional
// muted subline. `title` and `sub` may contain pre-built chip HTML, so they're
// passed through as-is — callers escape their own text.
export function row(title, { sub = '', last = false } = {}) {
  return `<div style="padding:11px 0;${last ? '' : `border-bottom:1px solid ${HAIR};`}">` +
    `<div style="font-size:15px;color:${INK};line-height:1.4;">${title}</div>` +
    (sub ? `<div style="font-size:13px;color:${INK_2};margin-top:3px;">${sub}</div>` : '') +
    `</div>`;
}

// A soft callout block — used for Claudia's weekly read.
export function quote(text) {
  return `<div style="background:#f6f8f7;border-left:3px solid ${BRAND};border-radius:8px;padding:12px 14px;font-size:14px;line-height:1.5;color:${INK};">${esc(text)}</div>`;
}

export function note(text) {
  return `<p style="margin:0;font-size:15px;line-height:1.5;color:${INK};">${esc(text)}</p>`;
}

// The full page shell: brand bar, icon badge + wordmark + title, a subtitle
// line (usually the date), the composed body, and a footer with the app link.
export function page({ title, subtitle = '', body }) {
  return `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light only"></head>` +
    `<body style="margin:0;padding:0;background:#eef2f0;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f0;"><tr>` +
    `<td align="center" style="padding:24px 12px;">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #e2e8e5;border-radius:16px;overflow:hidden;font-family:${FONT};">` +
    // brand bar
    `<tr><td style="height:4px;background:${BRAND};font-size:0;line-height:0;">&nbsp;</td></tr>` +
    // header
    `<tr><td style="padding:22px 28px 18px;border-bottom:1px solid ${HAIR};">` +
    `<table role="presentation" cellpadding="0" cellspacing="0"><tr>` +
    `<td style="padding-right:13px;vertical-align:middle;">` +
    // Maroon badge behind the icon: if a client blocks the external image, this
    // shows as a solid on-brand square rather than a broken-image glyph.
    `<table role="presentation" cellpadding="0" cellspacing="0"><tr>` +
    `<td width="42" height="42" style="width:42px;height:42px;background:${BRAND};border-radius:11px;text-align:center;vertical-align:middle;font-size:0;line-height:0;">` +
    `<img src="${APP_ICON}" width="42" height="42" alt="" style="display:block;width:42px;height:42px;border-radius:11px;">` +
    `</td></tr></table>` +
    `</td><td style="vertical-align:middle;">` +
    `<div style="font-size:11px;letter-spacing:.13em;text-transform:uppercase;color:${BRAND};font-weight:700;">Ortiz Home OS</div>` +
    `<div style="font-size:21px;font-weight:700;color:${INK};line-height:1.2;margin-top:2px;">${esc(title)}</div>` +
    `</td></tr></table>` +
    (subtitle ? `<div style="font-size:13px;color:${INK_2};margin-top:10px;">${esc(subtitle)}</div>` : '') +
    `</td></tr>` +
    // body
    `<tr><td style="padding:6px 28px 12px;">${body}</td></tr>` +
    // footer
    `<tr><td style="padding:18px 28px 24px;border-top:1px solid ${HAIR};">` +
    `<a href="${APP_URL}" style="display:inline-block;font-size:13px;font-weight:600;color:${BRAND};text-decoration:none;">Open Home OS &rarr;</a>` +
    `<div style="font-size:11px;color:${INK_3};margin-top:7px;">Sent automatically from your household Gist.</div>` +
    `</td></tr>` +
    `</table></td></tr></table></body></html>`;
}

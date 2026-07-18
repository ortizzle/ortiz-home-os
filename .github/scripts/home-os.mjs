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
  const {
    GMAIL_USER = 'chris.ortiz@gmail.com',
    GMAIL_APP_PASSWORD,
  } = process.env;
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

// Minimal, mobile-friendly HTML shell so the emails read cleanly in Gmail on
// a phone. Inline styles only — email clients ignore <style>/external CSS.
export function page(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;background:#f4f5f7;padding:20px 0;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2430;">
    <div style="padding:20px 24px;border-bottom:1px solid #eceef1;">
      <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#8a94a6;font-weight:600;">Ortiz Home OS</div>
      <div style="font-size:20px;font-weight:700;margin-top:2px;">${esc(title)}</div>
    </div>
    <div style="padding:20px 24px;font-size:15px;line-height:1.5;">${bodyHtml}</div>
    <div style="padding:14px 24px 20px;color:#a0a8b6;font-size:12px;border-top:1px solid #eceef1;">
      Sent automatically from the household Gist · <a href="https://ortizzle.github.io/ortiz-home-os/" style="color:#6b74e0;text-decoration:none;">Open Home OS</a>
    </div>
  </div>
</body></html>`;
}

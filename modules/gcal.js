// gcal.js — read-only Google Calendar overlay via Google Identity Services.
//
// Client-side only: a "Connect Google Calendar" tap requests a short-lived
// read-only access token (Google's OAuth token model), which stays on-device.
// We then read events straight from the Calendar REST API and overlay them on
// the Calendar and Meeting views — never persisted, never written back. The
// app cannot modify your Google Calendar (scope is calendar.readonly).

const CLIENT_ID = '305346848345-0q6ojf9t6eqhguh4pb3f2gm5p7rhhmtq.apps.googleusercontent.com';
// readonly: read events + list calendars. events: create/edit events (write).
// gmail.readonly: read message metadata + snippets so the house manager can
// factor recent email into the morning brief and answer questions about it.
// (A restricted scope — fine for our two test users; the app never sends mail.)
const SCOPE =
  'https://www.googleapis.com/auth/calendar.readonly ' +
  'https://www.googleapis.com/auth/calendar.events ' +
  'https://www.googleapis.com/auth/gmail.readonly';
const GSI_SRC = 'https://accounts.google.com/gsi/client';
const TOKEN_KEY = 'ohos.gcalToken';
const WRITE_CAL_KEY = 'ohos.gcalWriteCal';
const FAMILY_CAL = 'family04161634646034573603@group.calendar.google.com';

// Which calendars to overlay. Default to the family's shared calendars until
// the user picks their own set via the Settings picker (stored per device).
const DEFAULT_CALENDARS = [
  'family04161634646034573603@group.calendar.google.com', // Family
  '02vd7e4t7q4jgffv7aqefcl27g@group.calendar.google.com', // Personal Schedule (GOAT)
];
const CALS_KEY = 'ohos.gcalCalendars';

export function getSelectedCalendars() {
  try {
    const c = JSON.parse(localStorage.getItem(CALS_KEY));
    if (Array.isArray(c)) return c; // may be [] = "show none"
  } catch {}
  return DEFAULT_CALENDARS;
}
export function setSelectedCalendars(ids) {
  localStorage.setItem(CALS_KEY, JSON.stringify(ids));
  clearCache();
}

// Per-calendar display-name overrides (id -> short label), set from the
// Settings calendar picker. Most calendars need no entry here — guessCalName
// below derives a first name automatically — this only exists for the ones
// that don't, like a personal Google account whose address has no relation
// to the person's name ("kheningburg@..." for Kat).
const CAL_LABELS_KEY = 'ohos.gcalCalendarLabels';
export function getCalendarLabelOverrides() {
  try {
    const o = JSON.parse(localStorage.getItem(CAL_LABELS_KEY));
    if (o && typeof o === 'object') return o;
  } catch {}
  return {};
}
export function setCalendarLabelOverrides(overrides) {
  localStorage.setItem(CAL_LABELS_KEY, JSON.stringify(overrides || {}));
  clearCache();
}

export class GcalError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

// ---------- token (on-device, short-lived) ----------
// The access token expires ~hourly (Google's rule; no server = no refresh
// token). But the GRANT — the fact this browser already said yes to these
// scopes — persists on Google's side, so we keep the expired record as grant
// memory and renew silently (prompt: '') instead of re-asking for consent.

// The raw stored record, even when the token inside has expired.
function readGrant() {
  try { return JSON.parse(localStorage.getItem(TOKEN_KEY)); } catch { return null; }
}
function readToken() {
  const t = readGrant();
  return t && t.accessToken && t.expiresAt > Date.now() + 60_000 ? t : null;
}
function writeToken(accessToken, expiresInSec, scope) {
  localStorage.setItem(TOKEN_KEY, JSON.stringify({ accessToken, expiresAt: Date.now() + (expiresInSec || 3600) * 1000, scope: scope || '' }));
}
// Token died (expired / 401) — keep the grant memory, drop the credential.
function expireToken() {
  const g = readGrant();
  if (g) { g.accessToken = ''; g.expiresAt = 0; localStorage.setItem(TOKEN_KEY, JSON.stringify(g)); }
  clearCache();
  writableCache = null;
}
export function isConnected() { return !!readToken(); }
// Ever granted access on this device (even if the current token expired)?
export function everConnected() { return Boolean(readGrant()?.scope); }
// Does the app now want scopes the stored grant never covered? Then the next
// connect must show the consent screen; otherwise a silent/one-tap renewal.
function needsConsent() {
  const granted = (readGrant()?.scope || '').split(/\s+/).filter(Boolean);
  return SCOPE.split(/\s+/).some((s) => !granted.includes(s));
}
// Whether the granted token actually includes write access to events.
export function canWrite() {
  const t = readToken();
  return !!t && /calendar\.events|auth\/calendar(\s|$)/.test(t.scope || '');
}
// Whether the granted token includes Gmail read access. False for tokens
// minted before the gmail scope was added — a reconnect grants it.
export function canReadEmail() {
  const t = readToken();
  return !!t && /gmail\.readonly|gmail\.metadata/.test(t.scope || '');
}
// Explicit user action: forget the grant entirely.
export function disconnect() { localStorage.removeItem(TOKEN_KEY); clearCache(); writableCache = null; }

// The Google calendar new events are written to (default: Family).
export function getWriteCalendar() {
  return localStorage.getItem(WRITE_CAL_KEY) || FAMILY_CAL;
}
export function setWriteCalendar(id) {
  if (id) localStorage.setItem(WRITE_CAL_KEY, id);
}

// ---------- Google Identity Services ----------

let gsiReady = null;
let tokenClient = null;

function loadGsi() {
  if (gsiReady) return gsiReady;
  gsiReady = new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();
    const s = document.createElement('script');
    s.src = GSI_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new GcalError('Could not load Google sign-in', 'gsi-load'));
    document.head.append(s);
  });
  return gsiReady;
}

// error_callback must be fixed at init; route it through a mutable handler so
// each request can catch its own failures (popup blocked, window closed).
let onTokenError = null;

async function ensureClient() {
  await loadGsi();
  if (!tokenClient) {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: () => {}, // replaced per request
      error_callback: (err) => onTokenError?.(err),
    });
  }
  return tokenClient;
}

// Interactive connect (the button). Shows Google's consent screen only when
// it must (first connect on this device, or the app needs scopes the stored
// grant never covered). Otherwise prompt:'' — the popup opens and closes
// itself without asking anything.
export async function connect() {
  const client = await ensureClient();
  return new Promise((resolve, reject) => {
    onTokenError = (err) => reject(new GcalError(err?.message || 'Sign-in window was blocked or closed', 'oauth'));
    client.callback = (resp) => {
      if (resp.error) return reject(new GcalError(resp.error_description || resp.error, 'oauth'));
      writeToken(resp.access_token, resp.expires_in, resp.scope);
      clearCache();
      resolve(true);
    };
    client.requestAccessToken({ prompt: !everConnected() || needsConsent() ? 'consent' : '' });
  });
}

// Silent renewal: when the hourly token has lapsed but this device already
// granted everything the app wants, ask Google for a fresh token with no
// prompting — the popup self-closes if the browser has a live Google
// session. Resolves false (never throws) when it can't: popup blocked, no
// session, consent actually needed. Callers just fall back to disconnected.
let renewInFlight = null;
let renewFailedAt = 0; // back off after a failure (blocked popup, no session)
export function silentRenew() {
  if (readToken()) return Promise.resolve(true);
  if (!everConnected() || needsConsent()) return Promise.resolve(false);
  if (Date.now() - renewFailedAt < 120_000) return Promise.resolve(false);
  if (renewInFlight) return renewInFlight;
  renewInFlight = (async () => {
    try {
      const client = await ensureClient();
      const ok = await new Promise((resolve) => {
        onTokenError = () => resolve(false);
        client.callback = (resp) => {
          if (resp.error) return resolve(false);
          writeToken(resp.access_token, resp.expires_in, resp.scope);
          clearCache();
          resolve(true);
        };
        client.requestAccessToken({ prompt: '' });
      });
      if (!ok) renewFailedAt = Date.now();
      return ok;
    } catch {
      renewFailedAt = Date.now();
      return false;
    } finally {
      renewInFlight = null;
    }
  })();
  return renewInFlight;
}

// ---------- events ----------

// `${start}|${end}` -> { at, events }. Entries expire: an installed PWA can
// resume a suspended session hours or days later, and without a TTL the
// calendar half of every view (and of the daily brief) would keep serving
// events from the last fetch while the Gist half refreshed every 45s —
// confidently wrong about the one thing the family checks most.
const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map();
export function clearCache() { cache.clear(); }

function pad(n) { return String(n).padStart(2, '0'); }

// A Google event instance -> the same appointment shape the app renders.
// We slice the RFC3339 strings rather than parse via Date() so the wall-clock
// time is preserved exactly as Google stores it (no browser-TZ shifting).
// `calName` is the display name of the calendar the event came from — real
// attribution signal (Family vs a parent's personal calendar) for both the
// views and the AI prompts.
function toAppt(ev, calName) {
  if (ev.status === 'cancelled') return null;
  const start = ev.start || {};
  const end = ev.end || {};
  const allDay = Boolean(start.date);
  const date = allDay ? start.date : (start.dateTime || '').slice(0, 10);
  if (!date) return null;
  // Multi-day span (e.g. a trip). Google's all-day `end.date` is EXCLUSIVE
  // (a Jul 15–20 trip ends 2026-07-21), so step back a day for the last day
  // the family is actually away; timed events use the end date as-is. null
  // when it's a single-day event, so downstream code can treat those normally.
  const rawEnd = allDay ? (end.date ? addDaysStr(end.date, -1) : date) : ((end.dateTime || '').slice(0, 10) || date);
  const endDate = rawEnd && rawEnd > date ? rawEnd : null;
  return {
    id: 'live:' + ev.id,
    title: (ev.summary || '(untitled)').trim(),
    date,
    endDate,
    startTime: allDay ? null : (start.dateTime || '').slice(11, 16),
    endTime: allDay ? null : (end.dateTime || '').slice(11, 16),
    allDay,
    who: null,
    location: ev.location || null,
    seriesId: ev.recurringEventId || null,
    source: 'gcal',
    calendar: calName || null, // which Google calendar this came from
    htmlLink: ev.htmlLink || null, // open/edit this event in Google
  };
}

// Shared identity key for de-duping the same appointment appearing from
// multiple sources — content-based (title+date+time) rather than Google's
// iCalUID, so it also catches an event copied (not shared/invited) into more
// than one selected calendar, or a local appointment that predates Google
// being connected. Used both across calendars here and against local
// appointments in calendar.js's appointmentsFor().
//
// The title is normalized so trivial punctuation differences don't defeat the
// match: the family keeps the same event on more than one calendar with
// titles like "Chris's Self-Care Day" and "Chris Self-Care Day" — same day,
// same time, one real event. Dropping the possessive 's and reducing to bare
// words collapses those to one key. The date+time anchor keeps genuinely
// distinct events (and each day of a recurring series) separate.
function normTitle(t) {
  return (t || '')
    .toLowerCase()
    .replace(/['’]s\b/g, '')      // possessive: "chris's" -> "chris" (not "chriss")
    .replace(/[^a-z0-9]+/g, ' ')  // punctuation/whitespace -> single spaces
    .trim();
}
export function apptKey(a) {
  return `${normTitle(a.title)}|${a.date}|${a.allDay ? 'allday' : (a.startTime || '')}`;
}

async function apiGet(url) {
  const t = readToken();
  if (!t) throw new GcalError('Not connected to Google Calendar', 'not-connected');
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + t.accessToken } });
  if (res.status === 401) { expireToken(); throw new GcalError('Google sign-in expired', 'expired'); }
  if (!res.ok) throw new GcalError(`Calendar API ${res.status}`, 'api');
  return res.json();
}

// The calendars this account can read (for the Settings picker).
export async function listCalendars() {
  const data = await apiGet('https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader&maxResults=250');
  return (data.items || []).map((c) => ({
    id: c.id,
    summary: c.summaryOverride || c.summary || c.id,
    primary: Boolean(c.primary),
    accessRole: c.accessRole, // owner | writer | reader | freeBusyReader
  }));
}

// id -> display name for the account's calendars, fetched once per session.
// A FAILURE IS NOT CACHED: leaving the cache null means the next call retries,
// so one dropped request (or a token that expires mid-session) doesn't mute
// every calendar label — and the tentative flag with them — until a reload.
let calNamesCache = null;
async function calendarNames() {
  if (calNamesCache) return calNamesCache;
  try {
    calNamesCache = Object.fromEntries((await listCalendars()).map((c) => [c.id, c.summary]));
  } catch {
    return null; // caller falls back to the calendar id
  }
  return calNamesCache;
}

// A primary calendar's summary is usually a raw account identifier — an
// email (shorten to the local part: "chris.ortiz@gmail.com" -> "chris.ortiz")
// or an org-style dotted name ("sedona.nicole.ortiz") — so take just the
// first segment and capitalize it, reading as a first name ("Chris",
// "Sedona") instead of a slug. Named calendars ("Family", "Personal
// Schedule") have no dot before a word break, so they pass through as-is —
// re-capitalizing an already-capitalized first letter is a no-op.
// This is only a GUESS: an account whose address has no textual relation to
// the person's name (e.g. Kat's "kheningburg@...") won't resolve correctly —
// that's what the override map (below) is for, set from the Settings
// calendar picker.
export function guessCalName(summary) {
  const s = (summary || '').trim();
  const local = s.includes('@') ? s.split('@')[0] : s;
  const first = local.split('.')[0];
  return first ? first[0].toUpperCase() + first.slice(1) : local;
}

// Calendars this account can WRITE to (for the "Save to" target). Cached.
let writableCache = null;
export async function writableCalendars() {
  if (writableCache) return writableCache;
  const cals = await listCalendars();
  writableCache = cals.filter((c) => c.accessRole === 'owner' || c.accessRole === 'writer');
  return writableCache;
}

// Create an event on a Google calendar. Returns the created event.
export async function createEvent(calendarId, { title, date, endDate, startTime, endTime, allDay, location } = {}) {
  const t = readToken();
  if (!t) throw new GcalError('Not connected to Google Calendar', 'not-connected');
  const TZ = 'America/Phoenix';
  const body = { summary: (title || '').trim() || '(untitled)' };
  if (location) body.location = location;
  if (allDay) {
    body.start = { date };
    // Google all-day end is exclusive: a trip through endDate ends the day
    // after. Single-day (no endDate) → next day, as before.
    body.end = { date: addDaysStr(endDate && endDate > date ? endDate : date, 1) };
  } else {
    const st = startTime || '09:00';
    const et = endTime && et24(endTime) > et24(st) ? endTime : addMinutesStr(st, 60);
    body.start = { dateTime: `${date}T${st}:00`, timeZone: TZ };
    body.end = { dateTime: `${date}T${et}:00`, timeZone: TZ };
  }
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    { method: 'POST', headers: { Authorization: 'Bearer ' + t.accessToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  if (res.status === 401) { expireToken(); throw new GcalError('Google sign-in expired — reconnect', 'expired'); }
  if (res.status === 403) throw new GcalError('No write access — disconnect and reconnect to grant it', 'no-write');
  if (!res.ok) throw new GcalError(`Calendar API ${res.status}`, 'api');
  clearCache();
  return res.json();
}

function et24(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }
function addMinutesStr(hhmm, mins) {
  const total = et24(hhmm) + mins;
  return `${pad(Math.floor(total / 60) % 24)}:${pad(total % 60)}`;
}
function addDaysStr(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

// Overlay events for [start, end) (local YYYY-MM-DD). Cached per session.
// Returns [] when not connected, so callers can always await it safely.
// Self-heals: an expired token with an existing grant renews silently first
// (calls usually run right after a user tap, so the popup is allowed and
// auto-closes) — the hourly expiry stops being something you notice.
// Calendars this device's Google account couldn't read on the most recent
// LIVE fetch (a cache hit leaves this as whatever the last live fetch found —
// it isn't re-verified every render). A 403/etc. on one calendar used to be
// swallowed with zero signal, so a permission problem (e.g. this account
// never accepted the share, or lost access) silently dropped that calendar's
// events from every view forever with nothing to point at. Views can read
// this to tell the family which calendar to go check, instead of just
// quietly showing fewer events than are actually on the calendar.
let lastCalendarIssues = [];
export function getLastCalendarIssues() { return lastCalendarIssues; }

export async function eventsForRange(start, end, { force = false } = {}) {
  if (!isConnected() && !(await silentRenew())) return [];
  const key = `${start}|${end}`;
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.events;

  const timeMin = new Date(`${start}T00:00:00`).toISOString();
  const timeMax = new Date(`${end}T00:00:00`).toISOString();
  const out = [];
  const issues = [];
  // De-dupe the same event appearing on multiple selected calendars — both a
  // true shared/invited event (same iCalUID on each calendar) AND a plain
  // copy-pasted duplicate (different id/iCalUID, identical title+date+time).
  // Content-based apptKey() catches both; distinct events and each day of a
  // recurring series still have different keys, so those survive untouched.
  // Dedupe MERGES rather than skips: the surviving copy (Family-first)
  // collects every calendar the event appears on, so the label can read
  // "Family" for a shared event, "chris + kat" for a couple event living on
  // both parents' calendars, and the tentative flag can detect an event that
  // lives ONLY on the Social (soft-plans) calendar.
  const seen = new Map(); // apptKey -> surviving appointment
  // Null when the name lookup failed — fall back to the calendar id, which
  // is usually the account email and still labels the event usefully.
  const names = await calendarNames();
  const overrides = getCalendarLabelOverrides();
  const nameOf = (id) => overrides[id] || guessCalName((names && names[id]) || id || '');
  // Family calendar first: first-seen wins in this loop, so when the same
  // event lives on several calendars, the shared Family copy is the one that
  // survives dedupe — and the one whose calendar name the views and the AI
  // see. Stable sort keeps the user's order among the rest.
  const cals = getSelectedCalendars().slice().sort((a, b) => {
    const fam = (id) => (/family/i.test(nameOf(id)) ? 0 : 1);
    return fam(a) - fam(b);
  });
  for (const cal of cals) {
    try {
      // Page through: with singleEvents=true a daily recurrence expands to one
      // item per day, so a busy calendar over a multi-week window blows past
      // any single page — and the dropped events would vanish silently from
      // both the views and Claudia's context.
      let pageToken = null;
      do {
        const data = await apiGet(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal)}/events` +
          `?singleEvents=true&orderBy=startTime&maxResults=250` +
          `&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}` +
          (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '')
        );
        for (const ev of data.items || []) {
          const a = toAppt(ev, nameOf(cal));
          if (!a) continue;
          const dedupeKey = apptKey(a);
          const existing = seen.get(dedupeKey);
          if (existing) {
            if (a.calendar && !existing.calendars.includes(a.calendar)) existing.calendars.push(a.calendar);
            continue;
          }
          a.calendars = a.calendar ? [a.calendar] : [];
          seen.set(dedupeKey, a);
          out.push(a);
        }
        pageToken = data.nextPageToken || null;
      } while (pageToken);
    } catch (err) {
      if (err.code === 'expired' || err.code === 'not-connected') throw err;
      // A calendar this account can't read (e.g. not subscribed, access
      // revoked, or a share never accepted) — skip it so the rest of the
      // render still works, but remember which one so it can be surfaced
      // instead of just silently vanishing.
      issues.push({ id: cal, name: nameOf(cal) });
    }
  }
  // Finalize labels now that every copy has been seen. Family wins as the
  // display name (a Family event is confirmed and shared no matter where
  // else it's mirrored); otherwise the label lists every calendar it's on —
  // "chris + kat" reads as a couple event. An event living ONLY on a
  // "Social" calendar is a soft plan the family hasn't confirmed: flag it
  // tentative so views and prompts present it as a possibility, not a fact.
  for (const a of out) {
    const fam = a.calendars.find((n) => /family/i.test(n));
    a.calendar = fam || (a.calendars.join(' + ') || null);
    a.tentative = a.calendars.length > 0 && a.calendars.every((n) => /social/i.test(n));
  }
  lastCalendarIssues = issues;
  cache.set(key, { at: Date.now(), events: out });
  return out;
}

// ---------- Gmail (read-only: metadata + snippet, never bodies) ----------

async function gmailGet(url) {
  const t = readToken();
  if (!t) throw new GcalError('Not connected to Google', 'not-connected');
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + t.accessToken } });
  if (res.status === 401) { expireToken(); throw new GcalError('Google sign-in expired', 'expired'); }
  if (res.status === 403) throw new GcalError('No Gmail access — disconnect and reconnect to grant it', 'no-gmail');
  if (!res.ok) throw new GcalError(`Gmail API ${res.status}`, 'api');
  return res.json();
}

// Recent inbox mail, trimmed to what the house manager needs: sender, subject,
// date, and Gmail's own snippet. We fetch metadata only (never the full body)
// and skip Promotions/Social so the AI sees the mail that actually matters.
// Returns [] when not connected or the gmail scope wasn't granted.
export async function gmailRecent({ days = 7, max = 12 } = {}) {
  if (!readToken()) await silentRenew(); // self-heal an expired session
  if (!readToken() || !canReadEmail()) return [];
  const q = `newer_than:${days}d in:inbox -category:promotions -category:social`;
  const list = await gmailGet(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=${max}`);
  const ids = (list.messages || []).map((m) => m.id);
  const out = [];
  for (const id of ids) {
    try {
      const msg = await gmailGet(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}` +
        `?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`
      );
      const h = Object.fromEntries((msg.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
      out.push({
        from: (h.from || '').replace(/\s*<[^>]+>\s*/, '').replace(/"/g, '').trim() || h.from || '',
        subject: (h.subject || '(no subject)').trim(),
        date: h.date || '',
        snippet: (msg.snippet || '').trim(),
        unread: (msg.labelIds || []).includes('UNREAD'),
      });
    } catch (err) {
      if (err.code === 'expired' || err.code === 'no-gmail') throw err;
      // A single message that won't load — skip it, keep the rest.
    }
  }
  return out;
}

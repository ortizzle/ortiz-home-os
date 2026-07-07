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

export class GcalError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

// ---------- token (on-device, short-lived) ----------

function readToken() {
  try {
    const t = JSON.parse(localStorage.getItem(TOKEN_KEY));
    if (t && t.accessToken && t.expiresAt > Date.now() + 60_000) return t;
  } catch {}
  return null;
}
function writeToken(accessToken, expiresInSec, scope) {
  localStorage.setItem(TOKEN_KEY, JSON.stringify({ accessToken, expiresAt: Date.now() + (expiresInSec || 3600) * 1000, scope: scope || '' }));
}
export function isConnected() { return !!readToken(); }
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

async function ensureClient() {
  await loadGsi();
  if (!tokenClient) {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: () => {}, // replaced per request
    });
  }
  return tokenClient;
}

// Interactive connect (the button). Pops Google's consent, stores the token.
export async function connect() {
  const client = await ensureClient();
  return new Promise((resolve, reject) => {
    client.callback = (resp) => {
      if (resp.error) return reject(new GcalError(resp.error_description || resp.error, 'oauth'));
      writeToken(resp.access_token, resp.expires_in, resp.scope);
      clearCache();
      resolve(true);
    };
    // 'consent' so an existing read-only grant is re-prompted for the added
    // write scope; Google still remembers the account, so it's one tap.
    client.requestAccessToken({ prompt: 'consent' });
  });
}

// ---------- events ----------

const cache = new Map(); // `${start}|${end}` -> appointment-shaped array
export function clearCache() { cache.clear(); }

function pad(n) { return String(n).padStart(2, '0'); }

// A Google event instance -> the same appointment shape the app renders.
// We slice the RFC3339 strings rather than parse via Date() so the wall-clock
// time is preserved exactly as Google stores it (no browser-TZ shifting).
function toAppt(ev) {
  if (ev.status === 'cancelled') return null;
  const start = ev.start || {};
  const end = ev.end || {};
  const allDay = Boolean(start.date);
  const date = allDay ? start.date : (start.dateTime || '').slice(0, 10);
  if (!date) return null;
  return {
    id: 'live:' + ev.id,
    title: (ev.summary || '(untitled)').trim(),
    date,
    startTime: allDay ? null : (start.dateTime || '').slice(11, 16),
    endTime: allDay ? null : (end.dateTime || '').slice(11, 16),
    allDay,
    who: null,
    location: ev.location || null,
    seriesId: ev.recurringEventId || null,
    source: 'gcal',
    htmlLink: ev.htmlLink || null, // open/edit this event in Google
  };
}

async function apiGet(url) {
  const t = readToken();
  if (!t) throw new GcalError('Not connected to Google Calendar', 'not-connected');
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + t.accessToken } });
  if (res.status === 401) { disconnect(); throw new GcalError('Google sign-in expired', 'expired'); }
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

// Calendars this account can WRITE to (for the "Save to" target). Cached.
let writableCache = null;
export async function writableCalendars() {
  if (writableCache) return writableCache;
  const cals = await listCalendars();
  writableCache = cals.filter((c) => c.accessRole === 'owner' || c.accessRole === 'writer');
  return writableCache;
}

// Create an event on a Google calendar. Returns the created event.
export async function createEvent(calendarId, { title, date, startTime, endTime, allDay, location } = {}) {
  const t = readToken();
  if (!t) throw new GcalError('Not connected to Google Calendar', 'not-connected');
  const TZ = 'America/Phoenix';
  const body = { summary: (title || '').trim() || '(untitled)' };
  if (location) body.location = location;
  if (allDay) {
    body.start = { date };
    body.end = { date: addDaysStr(date, 1) }; // Google all-day end is exclusive
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
  if (res.status === 401) { disconnect(); throw new GcalError('Google sign-in expired — reconnect', 'expired'); }
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
export async function eventsForRange(start, end, { force = false } = {}) {
  if (!isConnected()) return [];
  const key = `${start}|${end}`;
  if (!force && cache.has(key)) return cache.get(key);

  const timeMin = new Date(`${start}T00:00:00`).toISOString();
  const timeMax = new Date(`${end}T00:00:00`).toISOString();
  const out = [];
  // De-dupe the same event appearing on multiple selected calendars (e.g. a
  // family event that's also on your personal calendar as an attendee). Key on
  // Google's stable iCalUID PLUS the instance start, so cross-calendar copies
  // collapse while distinct events and each day of a recurring series survive.
  const seen = new Set();
  for (const cal of getSelectedCalendars()) {
    try {
      const data = await apiGet(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal)}/events` +
        `?singleEvents=true&orderBy=startTime&maxResults=250` +
        `&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`
      );
      for (const ev of data.items || []) {
        const a = toAppt(ev);
        if (!a) continue;
        const dedupeKey = `${ev.iCalUID || ev.id}|${a.date}|${a.startTime || ''}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        out.push(a);
      }
    } catch (err) {
      if (err.code === 'expired' || err.code === 'not-connected') throw err;
      // A calendar this account can't read (e.g. not subscribed) — skip it.
    }
  }
  cache.set(key, out);
  return out;
}

// ---------- Gmail (read-only: metadata + snippet, never bodies) ----------

async function gmailGet(url) {
  const t = readToken();
  if (!t) throw new GcalError('Not connected to Google', 'not-connected');
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + t.accessToken } });
  if (res.status === 401) { disconnect(); throw new GcalError('Google sign-in expired', 'expired'); }
  if (res.status === 403) throw new GcalError('No Gmail access — disconnect and reconnect to grant it', 'no-gmail');
  if (!res.ok) throw new GcalError(`Gmail API ${res.status}`, 'api');
  return res.json();
}

// Recent inbox mail, trimmed to what the house manager needs: sender, subject,
// date, and Gmail's own snippet. We fetch metadata only (never the full body)
// and skip Promotions/Social so the AI sees the mail that actually matters.
// Returns [] when not connected or the gmail scope wasn't granted.
export async function gmailRecent({ days = 7, max = 12 } = {}) {
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

// gcal.js — read-only Google Calendar overlay via Google Identity Services.
//
// Client-side only: a "Connect Google Calendar" tap requests a short-lived
// read-only access token (Google's OAuth token model), which stays on-device.
// We then read events straight from the Calendar REST API and overlay them on
// the Calendar and Meeting views — never persisted, never written back. The
// app cannot modify your Google Calendar (scope is calendar.readonly).

const CLIENT_ID = '305346848345-0q6ojf9t6eqhguh4pb3f2gm5p7rhhmtq.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const GSI_SRC = 'https://accounts.google.com/gsi/client';
const TOKEN_KEY = 'ohos.gcalToken';

// Default calendars to overlay: the family's shared calendars. Each account
// reads these by ID as long as it's subscribed; any it can't access is
// skipped silently. Configurable later via a picker.
const DEFAULT_CALENDARS = [
  'family04161634646034573603@group.calendar.google.com', // Family
  '02vd7e4t7q4jgffv7aqefcl27g@group.calendar.google.com', // Personal Schedule (GOAT)
];

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
function writeToken(accessToken, expiresInSec) {
  localStorage.setItem(TOKEN_KEY, JSON.stringify({ accessToken, expiresAt: Date.now() + (expiresInSec || 3600) * 1000 }));
}
export function isConnected() { return !!readToken(); }
export function disconnect() { localStorage.removeItem(TOKEN_KEY); clearCache(); }

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
      writeToken(resp.access_token, resp.expires_in);
      clearCache();
      resolve(true);
    };
    // Show consent on first grant; Google returns silently on later grants.
    client.requestAccessToken({ prompt: '' });
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

// Overlay events for [start, end) (local YYYY-MM-DD). Cached per session.
// Returns [] when not connected, so callers can always await it safely.
export async function eventsForRange(start, end, { force = false } = {}) {
  if (!isConnected()) return [];
  const key = `${start}|${end}`;
  if (!force && cache.has(key)) return cache.get(key);

  const timeMin = new Date(`${start}T00:00:00`).toISOString();
  const timeMax = new Date(`${end}T00:00:00`).toISOString();
  const out = [];
  for (const cal of DEFAULT_CALENDARS) {
    try {
      const data = await apiGet(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal)}/events` +
        `?singleEvents=true&orderBy=startTime&maxResults=250` +
        `&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`
      );
      for (const ev of data.items || []) {
        const a = toAppt(ev);
        if (a) out.push(a);
      }
    } catch (err) {
      if (err.code === 'expired' || err.code === 'not-connected') throw err;
      // A calendar this account can't read (e.g. not subscribed) — skip it.
    }
  }
  cache.set(key, out);
  return out;
}

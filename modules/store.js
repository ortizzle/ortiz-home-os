// store.js — local-first data layer: IndexedDB + optional Gist sync.
// Ported from Ortiz Focus OS (tombstones included). Home OS twist: this is a
// TWO-USER dataset — both phones point at the same private Gist, and every
// record is stamped with `by` (the per-device display name) at creation.

const DB_NAME = 'ortiz-home-os';
const DB_VERSION = 6; // v2: 'agenda'; v3: 'plan'; v4: 'meals'+'suggLog'; v5: 'briefs'+'pins'+'reviews'; v6: 'meetingDrafts'
export const SCHEMA_VERSION = 1;

// Object stores that hold household records.
export const STORES = [
  'maintenance',
  'chores',
  'groceries',
  'vendors',
  'appointments',
  'goals',
  'agenda',
  'plan',
  'meals', // planned dinners: {date, title, detail}
  'suggLog', // AI follow-through memory: what was suggested, added, done
  'briefs', // Claudia's daily brief, one per date — shared, so both phones see the same read
  'pins', // notes pinned to a brief date
  'reviews', // Claudia's weekly review — one shared "current" record
  'meetingDrafts', // Claudia's meeting-agenda draft, one per meeting type (family/admin)
  'tombstones',
];

let dbPromise = null;

// ---------- tiny helpers ----------

export function uid() {
  return (
    Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
  );
}

export function now() {
  return new Date().toISOString();
}

// localStorage-backed settings (token + device identity live only on this
// device — deviceName is what stamps `by` on new records).
const SETTINGS_KEY = 'ohos.settings';

export function getSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
  } catch {
    return {};
  }
}

export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

export function deviceName() {
  return (getSettings().deviceName || '').trim() || null;
}

// ---------- IndexedDB core ----------

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id' });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      // VersionError: the DB was already upgraded by newer app code while
      // this (stale-cached) code asks for an older version. Open at the
      // current version instead — our stores are append-only, so a newer
      // schema is always a superset this code can safely use.
      if (req.error?.name === 'VersionError') {
        const retry = indexedDB.open(DB_NAME);
        retry.onsuccess = () => resolve(retry.result);
        retry.onerror = () => reject(retry.error);
      } else {
        reject(req.error);
      }
    };
  });
  return dbPromise;
}

function tx(store, mode) {
  return openDb().then((db) => db.transaction(store, mode).objectStore(store));
}

function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function get(store, id) {
  return reqToPromise((await tx(store, 'readonly')).get(id));
}

export async function getAll(store) {
  return reqToPromise((await tx(store, 'readonly')).getAll());
}

// put() stamps createdAt/updatedAt (and `by` for locally-created records)
// and returns the stored record. Merge puts pass touch:false and never
// re-stamp — a record keeps the `by` of whoever created it.
export async function put(store, record, { touch = true } = {}) {
  const rec = { ...record };
  if (!rec.id) rec.id = uid();
  if (!rec.createdAt) rec.createdAt = now();
  if (touch) {
    rec.updatedAt = now();
    if (!rec.by) rec.by = deviceName();
  }
  await reqToPromise((await tx(store, 'readwrite')).put(rec));
  scheduleSync();
  return rec;
}

export async function remove(store, id) {
  await reqToPromise((await tx(store, 'readwrite')).delete(id));
  // Record a tombstone so this deletion survives sync — without it, the
  // next pull merges the still-present remote copy right back in (newest-
  // updatedAt-wins has no concept of "gone").
  if (store !== 'tombstones') {
    await put('tombstones', { id: `${store}:${id}`, store, recordId: id, deletedAt: now() });
  }
  scheduleSync();
}

// ---------- snapshot (versioned, migration-ready) ----------

export async function exportSnapshot() {
  const data = {};
  for (const name of STORES) data[name] = await getAll(name);
  return { schemaVersion: SCHEMA_VERSION, updatedAt: now(), data };
}

// Merge an incoming snapshot: newest updatedAt wins per record, EXCEPT
// tombstoned records — a deletion (on either phone) is never resurrected
// by a later merge, unless a genuinely newer edit exists.
// Returns how many local records actually changed, so callers (like the
// background sync) can skip re-rendering when nothing did.
export async function mergeSnapshot(snapshot) {
  if (!snapshot || !snapshot.data) return 0;
  let changed = 0;
  // Future: if snapshot.schemaVersion < SCHEMA_VERSION, migrate here.

  // Tombstones merge first, so we know what NOT to bring back.
  for (const t of snapshot.data.tombstones || []) {
    if (!t || !t.id) continue;
    const existing = await get('tombstones', t.id);
    if (!existing || (t.updatedAt || '') > (existing.updatedAt || '')) {
      await put('tombstones', t, { touch: false });
    }
  }
  const tombstones = await getAll('tombstones');
  const tombSet = new Set(tombstones.map((t) => t.id)); // `${store}:${recordId}`

  for (const name of STORES) {
    if (name === 'tombstones') continue;
    const incoming = snapshot.data[name] || [];
    for (const rec of incoming) {
      if (!rec || !rec.id || tombSet.has(`${name}:${rec.id}`)) continue;
      const existing = await get(name, rec.id);
      if (!existing || (rec.updatedAt || '') > (existing.updatedAt || '')) {
        await put(name, rec, { touch: false });
        changed++;
      }
    }
  }

  // Purge any local record whose tombstone is newer than its last edit —
  // covers a phone that was offline with a stale copy when the deletion
  // happened on the other one.
  for (const t of tombstones) {
    if (!t.store || !t.recordId) continue;
    const existing = await get(t.store, t.recordId);
    if (existing && (existing.updatedAt || '') <= (t.deletedAt || '')) {
      await reqToPromise((await tx(t.store, 'readwrite')).delete(t.recordId));
      changed++;
    }
  }
  return changed;
}

// ---------- Gist sync ----------
// Household model: ONE private Gist, its owner's token configured on BOTH
// phones (a gist has exactly one writer). `by` attribution tells the
// records apart; newest-updatedAt-wins is acceptable for household data.

const GIST_FILENAME = 'ortiz-home-os.json';
let syncTimer = null;
const syncListeners = new Set();

export function onSyncStatus(fn) {
  syncListeners.add(fn);
  return () => syncListeners.delete(fn);
}

function emitSync(status) {
  syncListeners.forEach((fn) => fn(status));
}

export function syncConfigured() {
  const s = getSettings();
  return Boolean(s.gistToken && s.gistId);
}

async function gistFetch(path, options = {}) {
  const { gistToken } = getSettings();
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${gistToken}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Gist ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

// The remote data from the most recent pull. Pushes spread this UNDER the
// local export so any store this code version doesn't know about (added by a
// newer version running on the other phone) survives the full-file replace —
// a stale-code phone must never strip newer shared data from the Gist.
let lastRemoteData = null;

// Returns how many local records changed (0 on no-op or failure), so the
// background sync can re-render only when there's actually something new.
export async function pullFromGist() {
  if (!syncConfigured()) return 0;
  const { gistId } = getSettings();
  emitSync('syncing');
  let changed = 0;
  try {
    const gist = await gistFetch(`/gists/${gistId}`);
    const file = gist.files && gist.files[GIST_FILENAME];
    if (file && file.content) {
      const snapshot = JSON.parse(file.content);
      lastRemoteData = snapshot.data || null;
      changed = await mergeSnapshot(snapshot);
    }
    emitSync('synced');
  } catch (err) {
    console.warn('pullFromGist failed', err);
    emitSync('error');
  }
  return changed;
}

export async function pushToGist() {
  if (!syncConfigured()) return;
  const { gistId } = getSettings();
  emitSync('syncing');
  try {
    // Merge remote first so a push can never clobber records this phone
    // hasn't seen (e.g. items the other phone added an hour ago).
    await pullFromGist();
    const snapshot = await exportSnapshot();
    // Preserve remote stores this code version doesn't know about.
    if (lastRemoteData) snapshot.data = { ...lastRemoteData, ...snapshot.data };
    await gistFetch(`/gists/${gistId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        files: { [GIST_FILENAME]: { content: JSON.stringify(snapshot) } },
      }),
    });
    emitSync('synced');
  } catch (err) {
    console.warn('pushToGist failed', err);
    emitSync('error');
  }
}

// Debounced push (~5s) after writes.
function scheduleSync() {
  if (!syncConfigured()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => pushToGist(), 5000);
}

// Called once on boot: open db, then pull remote if configured.
export async function initStore() {
  await openDb();
  if (syncConfigured()) await pullFromGist();
}

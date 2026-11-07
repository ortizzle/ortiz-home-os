// gtasks.js — Kat's Google Tasks ↔ Home OS. Kat runs her life from Google
// Tasks (her Muse agent reads and writes it), so this keeps the two linked
// instead of making her keep two lists.
//
// Two jobs, both run ONLY on the device switched on as Kat's (Settings →
// Google). Google Tasks has no sharing like Calendar, so only the phone
// signed into her account can see her lists. Without the switch, any phone
// that connected Google would have its OWN tasks treated as Kat's.
//
//  1. Home OS → Google: household tasks assigned to Kat live in one
//     dedicated "Home OS" list in her Google Tasks, so Muse sees them where
//     she already plans. Kept in step both ways: checked off on either side
//     → done on the other; app edits (title/due/notes) push to Google; a
//     task reassigned away, or deleted in the app, is removed from the list.
//     The link lives on the chore (gtaskId), so it survives sync.
//
//  2. Google → Home OS (read-only): every OTHER list's open tasks are
//     mirrored into the synced 'kattasks' store, so every device and
//     Claudia can see her list. The Home OS list is excluded — those are
//     already household tasks, and mirroring them would count each twice.

import { getAll, put, remove, now } from './store.js';
import {
  canReadTasks, canWriteTasks, fetchGoogleTasks, listTaskLists, listTasksIn,
  createTaskList, insertTask, patchTask, deleteTask,
} from './gcal.js';

const SOURCE = 'gtasks';
const HOME_LIST_TITLE = 'Home OS';
const KAT_DEVICE_KEY = 'ohos.gtasksKatDevice';
const HOME_LIST_KEY = 'ohos.gtasksHomeList';
// Google task ids this device pushed into the Home OS list. A task whose
// chore was later deleted in the app is recognized as ours by this set and
// removed; anything Muse or Kat added to that list herself is left alone.
const PUSHED_KEY = 'ohos.gtasksPushed';
const idFor = (googleTaskId) => `gtask:${googleTaskId}`;

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }
function getPushed() { try { return new Set(JSON.parse(lsGet(PUSHED_KEY)) || []); } catch { return new Set(); } }
function savePushed(set) { lsSet(PUSHED_KEY, JSON.stringify([...set])); }

export function isKatDevice() { return lsGet(KAT_DEVICE_KEY) === '1'; }

// The last sync round's outcome on this device, for Settings. Failures used
// to only reach the console, which left "nothing is showing up" with no clue
// why — the same trap the calendar read-warning (v84) fixed.
const STATUS_KEY = 'ohos.gtasksStatus';
export function getKatTasksStatus() { try { return JSON.parse(lsGet(STATUS_KEY)); } catch { return null; } }
function saveStatus(st) { lsSet(STATUS_KEY, JSON.stringify({ at: new Date().toISOString(), ...st })); }
export function setKatDevice(on) { lsSet(KAT_DEVICE_KEY, on ? '1' : null); }
export const HOME_OS_LIST = HOME_LIST_TITLE;

const isKatChore = (c) => (c.assignee || '').trim().toLowerCase() === 'kat';

async function ensureHomeList() {
  const lists = await listTaskLists();
  const cached = lsGet(HOME_LIST_KEY);
  // Prefer the cached id; fall back to title so a reinstall reattaches to
  // the existing list instead of creating a second "Home OS".
  let list = lists.find((l) => l.id === cached) || lists.find((l) => l.title === HOME_LIST_TITLE);
  if (!list) list = await createTaskList(HOME_LIST_TITLE);
  lsSet(HOME_LIST_KEY, list.id);
  return list;
}

// Save a chore after reconciling it, stamping updatedAt and gtaskSyncedAt
// with the SAME instant (touch:false so put() doesn't re-stamp a later
// updatedAt) — "app changed since last sync" is then updatedAt > syncedAt.
async function saveSynced(chore, patch) {
  const t = now();
  await put('chores', { ...chore, ...patch, updatedAt: t, gtaskSyncedAt: t }, { touch: false });
}

// Push/pull between Kat's household tasks and the Home OS list. Returns
// whether any chore changed locally (callers re-render on that).
async function syncHomeList() {
  const list = await ensureHomeList();
  const remote = new Map((await listTasksIn(list, { includeCompleted: true })).map((t) => [t.id, t]));
  const chores = await getAll('chores');
  const pushed = getPushed();
  const linked = new Set();
  let changed = false;

  for (const c of chores) {
    // New: a household task for Kat with no Google twin yet.
    if (!c.gtaskId) {
      if (c.done || !isKatChore(c)) continue;
      const t = await insertTask(list.id, { title: c.title, notes: c.notes, due: c.dueDate });
      pushed.add(t.id);
      linked.add(t.id);
      await saveSynced(c, { gtaskId: t.id });
      changed = true;
      continue;
    }

    linked.add(c.gtaskId);
    const r = remote.get(c.gtaskId);

    // Reassigned away from Kat while still open: take it off her list.
    if (!isKatChore(c) && !c.done) {
      await deleteTask(list.id, c.gtaskId);
      pushed.delete(c.gtaskId);
      await saveSynced(c, { gtaskId: null });
      changed = true;
      continue;
    }

    // Deleted on Google's side (by Kat or Muse): treat as handled — mark the
    // chore done rather than delete shared data. Unticking it in the app
    // clears the link, so it gets pushed again as a fresh task.
    if (!r) {
      await saveSynced(c, c.done ? { gtaskId: null } : { gtaskId: null, done: true, doneAt: now(), doneBy: 'Kat (Google Tasks)' });
      pushed.delete(c.gtaskId);
      changed = true;
      continue;
    }

    const synced = c.gtaskSyncedAt || '';
    const appChanged = (c.updatedAt || '') > synced;
    const googleChanged = (r.updated || '') > synced;
    const googleDone = r.status === 'completed';

    // Done/not-done disagree: whichever side changed wins; both → newer wins.
    if (Boolean(c.done) !== googleDone) {
      const appWins = appChanged && (!googleChanged || (c.updatedAt || '') > (r.updated || ''));
      if (appWins) {
        await patchTask(list.id, r.id, { done: Boolean(c.done) });
        await saveSynced(c, {});
      } else {
        await saveSynced(c, googleDone
          ? { done: true, doneAt: r.completed || now(), doneBy: 'Kat (Google Tasks)' }
          : { done: false, doneAt: null, doneBy: null });
      }
      changed = true;
      continue;
    }

    // Content: the app is the source of truth for a household task's wording
    // and due date, pushed when it was edited here since the last sync.
    const contentDiffers = r.title !== c.title || (r.due || null) !== (c.dueDate || null) || (r.notes || null) !== ((c.notes || '').trim() || null);
    if (appChanged && contentDiffers) {
      await patchTask(list.id, r.id, { title: c.title, notes: c.notes || '', due: c.dueDate || null });
      await saveSynced(c, {});
      changed = true;
    }
  }

  // Ours, but its chore is gone (deleted in the app, or pruned long after
  // being done) — remove it from her list. Untracked tasks are left alone.
  for (const id of [...pushed]) {
    if (linked.has(id)) continue;
    if (remote.has(id)) await deleteTask(list.id, id);
    pushed.delete(id);
  }
  savePushed(pushed);
  return { changed, homeListId: list.id };
}

// Mirror every other list into 'kattasks' (read-only).
async function syncMirror(excludeListIds) {
  const live = await fetchGoogleTasks({ excludeListIds });
  const mirrored = (await getAll('kattasks')).filter((t) => t.source === SOURCE);
  const liveIds = new Set(live.map((t) => idFor(t.id)));
  let changed = false;
  for (const t of live) {
    const id = idFor(t.id);
    const existing = mirrored.find((m) => m.id === id);
    if (existing && existing.title === t.title && existing.due === t.due && existing.notes === t.notes && existing.listTitle === t.listTitle) continue;
    await put('kattasks', { id, title: t.title, due: t.due, notes: t.notes, listTitle: t.listTitle, source: SOURCE });
    changed = true;
  }
  for (const m of mirrored) {
    if (!liveIds.has(m.id)) { await remove('kattasks', m.id); changed = true; }
  }
  return changed;
}

// The whole round, on boot and in the background-sync loop. Best-effort and
// silent — a Google hiccup must never block boot. A cheap no-op on any
// device not switched on as Kat's. Returns whether anything changed.
let inFlight = null;
export function syncKatTasksToStore() {
  if (!isKatDevice()) return Promise.resolve(false);
  if (!canReadTasks()) {
    saveStatus({ ok: false, error: 'Google isn\'t connected with Tasks access on this phone — reconnect Google below.' });
    return Promise.resolve(false);
  }
  if (inFlight) return inFlight;
  inFlight = (async () => {
    let changed = false;
    let exclude = [];
    const errors = [];
    if (canWriteTasks()) {
      try {
        const r = await syncHomeList();
        changed = r.changed;
        exclude = [r.homeListId];
      } catch (err) {
        console.warn('Home OS list sync failed', err);
        errors.push(`Home OS list: ${err.message}`);
        const cached = lsGet(HOME_LIST_KEY);
        if (cached) exclude = [cached]; // still keep it out of the mirror
      }
    } else {
      errors.push('Read-only access only — reconnect Google to let the app keep the Home OS list.');
    }
    try { changed = (await syncMirror(exclude)) || changed; } catch (err) {
      console.warn('Google Tasks mirror failed', err);
      errors.push(`Reading her lists: ${err.message}`);
    }
    const linked = (await getAll('chores')).filter((c) => c.gtaskId && !c.done).length;
    const mirrored = (await getAll('kattasks')).filter((t) => t.source === SOURCE).length;
    saveStatus({ ok: !errors.length, error: errors.join(' · ') || null, linked, mirrored });
    return changed;
  })().finally(() => { inFlight = null; });
  return inFlight;
}

// Sorted, soonest-due first (no due date last).
export async function getKatTasks() {
  const all = await getAll('kattasks');
  return all.filter((t) => t.source === SOURCE).sort((a, b) => (a.due || '9999-99-99') < (b.due || '9999-99-99') ? -1 : 1);
}

// Compact prompt block, same spirit as school.js's schoolText().
export function kattasksText(tasks) {
  if (!tasks || !tasks.length) return '';
  return tasks.map((t) => `- ${t.title}${t.due ? ` (due ${t.due})` : ''}${t.notes ? ` — ${t.notes}` : ''}`).join('\n');
}

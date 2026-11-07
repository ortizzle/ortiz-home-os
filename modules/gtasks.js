// gtasks.js — mirrors Kat's Google Tasks into the shared, synced 'kattasks'
// store so every device (and Claudia's prompts) can see them, not just
// whichever phone is actually signed into her Google account.
//
// Google Tasks has no delegation/sharing like Calendar does — a task list is
// only ever visible to the account that owns it. So the live read only ever
// works on the device that connected with that account (Kat, on her phone).
// To make that useful household-wide, her device periodically reconciles the
// live read into 'kattasks' (an upsert + remove-what's-gone diff, keyed by
// the Google task id), and that store rides the app's normal Gist sync like
// any other record — Chris's phone, and Claudia's brief, just read the
// mirror. Read-only end to end: nothing is ever written back to Google.

import { getAll, put, remove } from './store.js';
import { fetchGoogleTasks, canReadTasks } from './gcal.js';

const SOURCE = 'gtasks';
const idFor = (googleTaskId) => `gtask:${googleTaskId}`;

// Best-effort, silent: a hiccup here (offline, token hiccup) must never block
// boot or the background sync loop. Cheap no-op on any device that hasn't
// granted Tasks access (the common case — only Kat's device will). Returns
// whether anything actually changed, so callers (boot, background sync) can
// skip re-rendering when there's nothing new — same convention as
// store.js's pullFromGist().
export async function syncKatTasksToStore() {
  if (!canReadTasks()) return false;
  let live;
  try { live = await fetchGoogleTasks(); } catch { return false; }

  const mirrored = (await getAll('kattasks')).filter((t) => t.source === SOURCE);
  const liveIds = new Set(live.map((t) => idFor(t.id)));
  let changed = false;

  for (const t of live) {
    const id = idFor(t.id);
    const existing = mirrored.find((m) => m.id === id);
    // Skip the write (and the Gist push it would trigger) when nothing changed.
    if (existing && existing.title === t.title && existing.due === t.due && existing.notes === t.notes && existing.listTitle === t.listTitle) continue;
    await put('kattasks', { id, title: t.title, due: t.due, notes: t.notes, listTitle: t.listTitle, source: SOURCE });
    changed = true;
  }
  // Gone from the live read (completed, deleted, or moved off-list in Google
  // Tasks) — remove the mirror so it disappears from every device, not just
  // this one.
  for (const m of mirrored) {
    if (!liveIds.has(m.id)) { await remove('kattasks', m.id); changed = true; }
  }
  return changed;
}

// Sorted, soonest-due first (no due date last) — same shape every reader wants.
export async function getKatTasks() {
  const all = await getAll('kattasks');
  return all.filter((t) => t.source === SOURCE).sort((a, b) => (a.due || '9999-99-99') < (b.due || '9999-99-99') ? -1 : 1);
}

// Compact prompt block, same spirit as school.js's schoolText().
export function kattasksText(tasks) {
  if (!tasks || !tasks.length) return '';
  return tasks.map((t) => `- ${t.title}${t.due ? ` (due ${t.due})` : ''}${t.notes ? ` — ${t.notes}` : ''}`).join('\n');
}

// hmcontext.js — gathers + formats the household state the house-manager AI
// reads. Shared by the Home daily brief and the Manager weekly review.
// Also home of the suggestion log (the AI's follow-through memory) and the
// brief pins.

import { getAll, get, put, remove as removeRec } from './store.js';
import { addDays, fmtDay, todayStr } from './ui.js';
import { getMaintenance, nextDue, dueState } from './maintenance.js';
import { isConnected, eventsForRange, canReadEmail, gmailRecent } from './gcal.js';
import { STORES } from './grocery.js';

// The family's habits/preferences, fed to the house-manager AI. Editable in
// Settings → "Notes for the assistant"; this is the default seed.
export const DEFAULT_HOUSEHOLD_NOTES =
  "Shopping habits: Costco — go during executive hours right when it opens (weekend mornings). Trader Joe's — quick, local runs for a few items. Walmart — usually home delivery, for items we don't want in Costco bulk sizes.";

// Standing food rules for the dinner planner. Editable in Settings.
export const DEFAULT_FOOD_NOTES =
  'Weeknight dinners: quick (~30 minutes) and healthy-ish, kid-friendly. Bigger cooking projects are for weekends.';

// Default kids line for age-appropriate chore ideas. Editable in Settings.
export const DEFAULT_KIDS = 'Sedona and River (roughly 8–12)';

// ---------- brief pins (synced — a pin either of you adds, both of you see) ----------

export async function pinToBrief(date, text) {
  await put('pins', { date, text });
}
export async function removePin(id) {
  await removeRec('pins', id);
}
// A pin shows once its date arrives and stays until dismissed.
export async function pinsFor(date) {
  const all = await getAll('pins');
  return all.filter((p) => (p.date || '') <= date);
}

// ---------- shared daily brief (synced — Claudia's morning read, same for both phones) ----------
// Keyed by date (one record per day), so whichever phone opens first in the
// morning generates it, and the other phone's Home tab shows the identical
// read instead of paying for and generating a second, possibly-different one.

export async function getBrief(date) {
  return get('briefs', date);
}
export async function saveBrief(date, data) {
  await put('briefs', { id: date, data, added: [] });
}
export async function markBriefAdded(date, title) {
  const b = await get('briefs', date);
  if (!b) return;
  await put('briefs', { ...b, added: [...new Set([...(b.added || []), title])] });
}

// ---------- shared weekly review (synced — a single "current" record) ----------
// No expiry: it lives until either of you runs a fresh one (the ~2x/week
// rhythm), so both phones show the same plan, the same dismissals, and the
// same resolved questions.

const REVIEW_ID = 'current';
export async function getReview() {
  return get('reviews', REVIEW_ID);
}
export async function saveReview(data) {
  await put('reviews', { id: REVIEW_ID, reviewedAt: todayStr(), data, added: [], dismissed: [], resolved: {} });
}
async function patchReview(fn) {
  const r = await get('reviews', REVIEW_ID);
  if (!r) return;
  fn(r);
  await put('reviews', r);
}
export const markReviewAdded = (title) => patchReview((r) => { r.added = [...new Set([...(r.added || []), title])]; });
export const markReviewDismissed = (title) => patchReview((r) => { r.dismissed = [...new Set([...(r.dismissed || []), title])]; });
export const markQuestionResolved = (q, answer) => patchReview((r) => { r.resolved = { ...(r.resolved || {}), [q]: answer || true }; });

function to12(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

// ---------- suggestion log (the AI's follow-through memory; synced) ----------
// Every AI suggestion shown gets logged; adding one records where it went.
// The weekly review reads this back so it can follow up on what was added
// but never finished, and stop repeating what the family keeps ignoring.

const normKey = (title) => (title || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim().slice(0, 80);

// Log a batch of freshly-generated suggestions. Repeat sightings of the same
// title bump a counter instead of piling up rows.
export async function logShownSuggestions(items, source) {
  const log = await getAll('suggLog');
  for (const it of items || []) {
    const key = normKey(it.title);
    if (!key) continue;
    const existing = log.find((r) => r.key === key);
    if (existing) {
      await put('suggLog', { ...existing, lastShownAt: todayStr(), shownCount: (existing.shownCount || 1) + 1 });
    } else {
      await put('suggLog', { key, title: it.title, type: it.suggestedType || it.type || 'task', source, firstShownAt: todayStr(), lastShownAt: todayStr(), shownCount: 1, addedAt: null, targetStore: null, targetId: null });
    }
  }
}

// Record that a suggestion was accepted (one-tap added) and where it landed.
export async function logSuggestionAdded(title, targetStore, targetId) {
  const key = normKey(title);
  if (!key) return;
  const log = await getAll('suggLog');
  const entry = log.find((r) => r.key === key);
  if (entry) await put('suggLog', { ...entry, addedAt: todayStr(), targetStore, targetId: targetId || null });
}

// Record that the family dismissed (✕) a suggestion — declined for good.
// Claudia's prompts treat these as off the table permanently.
export async function logSuggestionDismissed(title) {
  const key = normKey(title);
  if (!key) return;
  const log = await getAll('suggLog');
  const entry = log.find((r) => r.key === key);
  if (entry) await put('suggLog', { ...entry, dismissedAt: todayStr() });
  else await put('suggLog', { key, title, type: 'task', source: 'review', firstShownAt: todayStr(), lastShownAt: todayStr(), shownCount: 1, dismissedAt: todayStr() });
}

// Record the family's answer to one of Claudia's questions (or a plain
// "resolved") so she builds on it instead of re-asking.
export async function logQuestionResolved(question, answer = '') {
  const key = normKey(question);
  if (!key) return;
  const log = await getAll('suggLog');
  const entry = log.find((r) => r.key === key);
  const base = entry || { key, title: question, source: 'review', firstShownAt: todayStr(), lastShownAt: todayStr(), shownCount: 1 };
  await put('suggLog', { ...base, type: 'question', resolvedAt: todayStr(), answer: answer.trim() || null });
}

// Did the record a suggestion turned into actually get done?
async function targetDone(store, id) {
  if (!store || !id) return false;
  const rec = await get(store, id).catch(() => null);
  if (!rec) return false;
  if (store === 'chores' || store === 'plan') return Boolean(rec.done);
  if (store === 'groceries') return Boolean(rec.gotAt);
  if (store === 'appointments') return (rec.date || '') < todayStr(); // it happened
  return false;
}

// The follow-through block for the weekly review prompt — and housekeeping:
// entries older than ~5 weeks are pruned so the log stays small.
export async function followUpText() {
  const log = await getAll('suggLog');
  const cutoff = addDays(todayStr(), -35);
  const lines = [];
  for (const r of log) {
    // Declined suggestions and answered questions are kept indefinitely —
    // "gone for good" only works if the memory outlives the prune window.
    if (r.dismissedAt) {
      lines.push(`- "${r.title}" — DECLINED by the family (${fmtDay(r.dismissedAt)}); never suggest this again`);
      continue;
    }
    if (r.type === 'question' && r.resolvedAt) {
      lines.push(`- You asked: "${r.title}" — ${r.answer ? `family answered: "${r.answer}"` : 'resolved, no longer an issue'}`);
      continue;
    }
    if ((r.lastShownAt || '') < cutoff) { await removeRec('suggLog', r.id); continue; }
    if (r.addedAt) {
      const done = await targetDone(r.targetStore, r.targetId);
      lines.push(`- "${r.title}" — added ${fmtDay(r.addedAt)}${done ? ', DONE ✓' : ', not completed yet'}`);
    } else if ((r.shownCount || 1) >= 2) {
      lines.push(`- "${r.title}" — suggested ${r.shownCount} times, never added (the family may not want this)`);
    }
  }
  return lines.join('\n');
}

// Format recent email into a compact block for the prompt. Sender + subject +
// a short snippet is enough for the AI to flag what needs attention.
export function emailText(emails) {
  return (emails || [])
    .map((e) => `- ${e.unread ? '(unread) ' : ''}${e.from} — ${e.subject}${e.snippet ? `: ${e.snippet.slice(0, 160)}` : ''}`)
    .join('\n');
}

// Returns text blocks for the AI prompt. `start` (YYYY-MM-DD) and `days`
// bound the calendar window pulled from the live Google overlay. Pass
// `email: true` to also pull recent Gmail (when the scope was granted).
export async function gatherContext({ start, days, email = false }) {
  const [chores, groceries, maintenance, plan, meals] = await Promise.all([
    getAll('chores'),
    getAll('groceries'),
    getMaintenance(),
    getAll('plan'),
    getAll('meals'),
  ]);
  const events = isConnected() ? await eventsForRange(start, addDays(start, days)).catch(() => []) : [];
  const emails = email && canReadEmail() ? await gmailRecent({ days: 7 }).catch(() => []) : [];

  const eventsText = events
    .slice()
    .sort((a, b) => (a.date + (a.startTime || '') < b.date + (b.startTime || '') ? -1 : 1))
    .map((e) => `- ${fmtDay(e.date)}${e.startTime ? ' ' + to12(e.startTime) : ' (all day)'}: ${e.title}`)
    .join('\n');

  const choresText = chores.filter((c) => !c.done).map((c) => `- ${c.title}${c.dueDate ? ` (due ${c.dueDate})` : ''}`).join('\n');
  const upkeepText = maintenance.filter((m) => dueState(m) !== 'ok').map((m) => `- ${m.title} (due ${nextDue(m)})`).join('\n');

  const byStore = {};
  for (const g of groceries.filter((x) => !x.gotAt)) { const s = g.store || STORES[0]; (byStore[s] ||= []).push(g.name); }
  const groceriesText = Object.entries(byStore).map(([s, names]) => `${s}: ${names.join(', ')}`).join('\n');

  const planText = plan.filter((p) => !p.done).map((p) => `- ${p.title}`).join('\n');

  const end = addDays(start, days);
  const mealsInRange = meals
    .filter((m) => m.date >= start && m.date < end)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const mealsText = mealsInRange.map((m) => `- ${fmtDay(m.date)}: ${m.title}`).join('\n');

  return { events, eventsText, choresText, upkeepText, groceriesText, planText, meals: mealsInRange, mealsText, emails, emailsText: emailText(emails) };
}

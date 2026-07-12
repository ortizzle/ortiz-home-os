// hmcontext.js — gathers + formats the household state the house-manager AI
// reads. Shared by the Home daily brief and the Manager weekly review.
// Also home of the suggestion log (the AI's follow-through memory) and the
// brief pins.

import { getAll, get, put, remove as removeRec } from './store.js';
import { addDays, fmtDay, todayStr } from './ui.js';
import { eventsForRange, canReadEmail, gmailRecent } from './gcal.js';
import { STORES } from './grocery.js';

// The family's habits/preferences, fed to the house-manager AI. Editable in
// Settings → "Notes for the assistant"; this is the default seed.
export const DEFAULT_HOUSEHOLD_NOTES =
  "Shopping habits: Costco — go during executive hours right when it opens (weekend mornings). Trader Joe's — quick, local runs for a few items. Walmart — usually home delivery, for items we don't want in Costco bulk sizes.\n\n" +
  "Pets: two dogs — Cookie (female) and Biscuit (male), littermates we brought home as 6–8-week-old puppies on Mother's Day (May 9) 2021, so born ~spring 2021 — and a bearded dragon named Sunny.\n\n" +
  "Standing weekly care we tend to forget (a nudge helps): clean Sunny's terrarium once a week, and brush the dogs' teeth. Neither is tracked as a task, so it's welcome to remind us in the weekly review — ideally folded into the weekend.\n\n" +
  "Birthdays: Chris — February 26, 1981; Kat — August 15, 1981 (the kids' birthdays are in the kids note). Get ahead of each one with real lead time — a card and a gift, ordered early enough to arrive.";

// Standing food rules for the dinner planner. Editable in Settings.
export const DEFAULT_FOOD_NOTES =
  'Weeknight dinners: quick (~30 minutes) and healthy-ish, kid-friendly. Bigger cooking projects are for weekends.';

// Default kids line for age-appropriate chore ideas and birthday lead time.
// Editable in Settings.
export const DEFAULT_KIDS = 'Sedona (12, born Dec 17, 2013) and River (9, born Jan 11, 2017)';

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
  // Briefs are one-per-day records that are only ever read for TODAY — prune
  // anything older than 2 weeks so the store (and sync payload) has an end
  // state instead of growing forever.
  const cutoff = addDays(date, -14);
  for (const b of await getAll('briefs')) {
    if (b.id < cutoff) await removeRec('briefs', b.id);
  }
}
export async function markBriefAdded(date, title) {
  const b = await get('briefs', date);
  if (!b) return;
  await put('briefs', { ...b, added: [...new Set([...(b.added || []), title])] });
}
// "Not needed" — clears a suggestion from view for the satisfying, checked-
// off feeling, but keeps no permanent memory: it's fair game for a future
// brief, unlike an accepted suggestion (which becomes a real task).
export async function markBriefDismissed(date, title) {
  const b = await get('briefs', date);
  if (!b) return;
  await put('briefs', { ...b, dismissed: [...new Set([...(b.dismissed || []), title])] });
}

// ---------- shared weekly review (synced — a single "current" record) ----------
// No expiry: it lives until either of you runs a fresh one (the ~2x/week
// rhythm), so both phones show the same plan, the same dismissals, and the
// same resolved questions.

const REVIEW_ID = 'current';
// Belt-and-braces: every review write is mirrored to localStorage. Reviews
// are user-curated (added/dismissed/answered) and expensive to lose — this
// mirror rescues them if the synced record ever goes missing (a mixed-version
// session during an app update, a stale-code phone rewriting the sync file,
// or the original pre-v21 localStorage copy that was never migrated).
const REVIEW_MIRROR_KEY = 'ohos.weekReview';
function mirrorReview(rec) {
  try { localStorage.setItem(REVIEW_MIRROR_KEY, JSON.stringify(rec)); } catch {}
}
export async function getReview() {
  const r = await get('reviews', REVIEW_ID);
  if (r) return r;
  // Rescue: restore from the mirror (also covers pre-v21 legacy reviews,
  // which used this same key with a compatible shape).
  try {
    const m = JSON.parse(localStorage.getItem(REVIEW_MIRROR_KEY));
    if (m?.data) {
      return await put('reviews', {
        id: REVIEW_ID,
        reviewedAt: m.reviewedAt || todayStr(),
        data: m.data,
        added: m.added || [],
        dismissed: m.dismissed || [],
        resolved: m.resolved || {},
        dives: m.dives || {},
      });
    }
  } catch {}
  return null;
}
export async function saveReview(data) {
  const rec = await put('reviews', { id: REVIEW_ID, reviewedAt: todayStr(), data, added: [], dismissed: [], resolved: {}, dives: {} });
  mirrorReview(rec);
}
async function patchReview(fn) {
  const r = await get('reviews', REVIEW_ID);
  if (!r) return;
  fn(r);
  const rec = await put('reviews', r);
  mirrorReview(rec);
}
export const markReviewAdded = (title) => patchReview((r) => { r.added = [...new Set([...(r.added || []), title])]; });
export const markReviewDismissed = (title) => patchReview((r) => { r.dismissed = [...new Set([...(r.dismissed || []), title])]; });
export const markQuestionResolved = (q, answer) => patchReview((r) => { r.resolved = { ...(r.resolved || {}), [q]: answer || true }; });
// A deep-dive write-up (on a suggestion or a question) is worth keeping — it
// cost a Claude call and both phones should see it. Keyed by the item's
// title/question; lives as long as the review does.
export const markReviewDived = (title, text) => patchReview((r) => { r.dives = { ...(r.dives || {}), [title]: text }; });

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
    // Answered questions are kept indefinitely so Claudia never re-asks.
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

// Read-only, human-facing view of Claudia's follow-through memory (for the
// Settings "What Claudia knows" page). Same underlying data as
// followUpText() but grouped for display and WITHOUT the pruning
// side-effect — viewing your memory should never delete it.
export async function getSuggestionMemory() {
  const log = await getAll('suggLog');
  const resolved = [];
  const added = [];
  const repeated = [];
  for (const r of log) {
    if (r.type === 'question' && r.resolvedAt) {
      resolved.push({ question: r.title, answer: r.answer || null, resolvedAt: r.resolvedAt });
    } else if (r.addedAt) {
      added.push({ title: r.title, addedAt: r.addedAt, done: await targetDone(r.targetStore, r.targetId) });
    } else if ((r.shownCount || 1) >= 2) {
      repeated.push({ title: r.title, shownCount: r.shownCount });
    }
  }
  resolved.sort((a, b) => (b.resolvedAt || '').localeCompare(a.resolvedAt || ''));
  added.sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));
  return { resolved, added, repeated };
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
  const [chores, groceries, plan, meals, agenda] = await Promise.all([
    getAll('chores'),
    getAll('groceries'),
    getAll('plan'),
    getAll('meals'),
    getAll('agenda'),
  ]);
  // eventsForRange() already checks the connection and self-heals with a
  // silent token renewal if needed — an outer isConnected() gate here would
  // skip straight to "no events" without giving that renewal a chance, which
  // is exactly how the daily brief used to get cached (for the whole day,
  // shared with Kat) claiming "nothing on the calendar" moments before a
  // renewal landed and the real calendar reappeared everywhere else.
  const events = await eventsForRange(start, addDays(start, days)).catch(() => []);
  const emails = email && canReadEmail() ? await gmailRecent({ days: 7 }).catch(() => []) : [];

  const eventsText = events
    .slice()
    .sort((a, b) => (a.date + (a.startTime || '') < b.date + (b.startTime || '') ? -1 : 1))
    .map((e) => e.endDate && e.endDate > e.date
      // Multi-day event (a trip/vacation) — show the full span so Claudia can
      // plan lead-time around it (packing, prep, who's away when).
      ? `- ${fmtDay(e.date)}–${fmtDay(e.endDate)} (MULTI-DAY / trip): ${e.title}`
      : `- ${fmtDay(e.date)}${e.startTime ? ' ' + to12(e.startTime) : ' (all day)'}: ${e.title}`)
    .join('\n');

  const choresText = chores.filter((c) => !c.done).map((c) => `- ${c.title}${c.dueDate ? ` (due ${c.dueDate})` : ''}`).join('\n');

  const byStore = {};
  for (const g of groceries.filter((x) => !x.gotAt)) { const s = g.store || STORES[0]; (byStore[s] ||= []).push(g.name); }
  const groceriesText = Object.entries(byStore).map(([s, names]) => `${s}: ${names.join(', ')}`).join('\n');

  const planText = plan.filter((p) => !p.done).map((p) => `- ${p.title}`).join('\n');

  // Open (unreviewed) meeting-agenda items, so suggestions don't duplicate a
  // topic the family already queued for a meeting.
  const agendaText = agenda.filter((a) => !a.reviewed).map((a) => `- ${a.text}`).join('\n');

  // What the family actually DECIDED at recent meetings (last ~3 weeks) — so
  // the weekly review follows through on decisions instead of re-raising them.
  const decisionCutoff = addDays(start, -21);
  const meetingDecisionsText = agenda
    .filter((a) => a.reviewed && a.decision && a.cycleDate && a.cycleDate >= decisionCutoff)
    .map((a) => `- ${a.text}: ${a.decision}`)
    .join('\n');

  const end = addDays(start, days);
  const mealsInRange = meals
    .filter((m) => m.date >= start && m.date < end)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const mealsText = mealsInRange.map((m) => `- ${fmtDay(m.date)}: ${m.title}`).join('\n');

  return { events, eventsText, choresText, groceriesText, planText, agendaText, meetingDecisionsText, meals: mealsInRange, mealsText, emails, emailsText: emailText(emails) };
}

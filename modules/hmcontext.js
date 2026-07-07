// hmcontext.js — gathers + formats the household state the house-manager AI
// reads. Shared by the Home daily brief and the Manager weekly review.

import { getAll } from './store.js';
import { addDays, fmtDay } from './ui.js';
import { getMaintenance, nextDue, dueState } from './maintenance.js';
import { isConnected, eventsForRange, canReadEmail, gmailRecent } from './gcal.js';
import { STORES } from './grocery.js';

// The family's habits/preferences, fed to the house-manager AI. Editable in
// Settings → "Notes for the assistant"; this is the default seed.
export const DEFAULT_HOUSEHOLD_NOTES =
  "Shopping habits: Costco — go during executive hours right when it opens (weekend mornings). Trader Joe's — quick, local runs for a few items. Walmart — usually home delivery, for items we don't want in Costco bulk sizes.";

// ---------- brief pins (per-device: notes the family pins to the morning brief) ----------

const PINS_KEY = 'ohos.briefPins';
export function readPins() { try { return JSON.parse(localStorage.getItem(PINS_KEY)) || []; } catch { return []; } }
function writePins(p) { localStorage.setItem(PINS_KEY, JSON.stringify(p)); }
export function pinToBrief(date, text) {
  const pins = readPins();
  pins.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, date, text });
  writePins(pins);
}
export function removePin(id) { writePins(readPins().filter((p) => p.id !== id)); }
// A pin shows once its date arrives and stays until dismissed.
export function pinsFor(date) { return readPins().filter((p) => (p.date || '') <= date); }

function to12(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
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
  const [chores, groceries, maintenance, plan] = await Promise.all([
    getAll('chores'),
    getAll('groceries'),
    getMaintenance(),
    getAll('plan'),
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

  return { events, eventsText, choresText, upkeepText, groceriesText, planText, emails, emailsText: emailText(emails) };
}

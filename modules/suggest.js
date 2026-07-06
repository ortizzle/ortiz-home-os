// suggest.js — the deterministic rule engine. Pure: takes household state,
// returns suggestion objects for Home to render. v1 smart = rules, not AI —
// it should feel attentive, not clever. Calendar-driven triggers arrive in
// v1.5; a Claude-powered advisor is a v2 decision.

import { todayStr, addDays, fmtDue } from './ui.js';
import { nextDue } from './maintenance.js';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Is today or tomorrow an errand day? Returns null, 'today', or 'tomorrow'.
export function errandWindow(settings) {
  const days = settings.errandDays || [6]; // default: Saturday
  const now = new Date();
  if (days.includes(now.getDay())) return 'today';
  if (days.includes((now.getDay() + 1) % 7)) return 'tomorrow';
  return null;
}

export function buildSuggestions({ maintenance = [], chores = [], groceries = [], appointments = [], settings = {} }) {
  const out = [];
  const today = todayStr();
  const openGroceries = groceries.filter((g) => !g.gotAt);

  // 1. Errand day + open grocery items → the Costco nudge.
  const win = errandWindow(settings);
  if (win && openGroceries.length) {
    out.push({
      urgent: false,
      text: `${DAY_NAMES[new Date().getDay() + (win === 'tomorrow' ? 1 : 0)] || 'Errand day'} is errand day ${win} — ${openGroceries.length} item${openGroceries.length === 1 ? '' : 's'} on the list`,
      hash: '#/grocery',
      go: 'View list',
    });
  }

  // 2. Overdue maintenance → schedule or do it.
  for (const it of maintenance.filter((m) => nextDue(m) < today).slice(0, 2)) {
    const days = Math.round((new Date(today) - new Date(nextDue(it))) / 86400000);
    out.push({
      urgent: true,
      text: `${it.title} is ${days} day${days === 1 ? '' : 's'} overdue`,
      hash: '#/upkeep',
      go: 'Upkeep',
    });
  }

  // 3. Maintenance due within 7 days → heads-up.
  for (const it of maintenance.filter((m) => nextDue(m) >= today && nextDue(m) <= addDays(today, 7)).slice(0, 2)) {
    out.push({
      urgent: false,
      text: `${it.title} due ${fmtDue(nextDue(it))}`,
      hash: '#/upkeep',
      go: 'Upkeep',
    });
  }

  // 4. Vendor-linked chore with no date → it'll never happen on its own.
  const dateless = chores.find((c) => !c.done && c.vendorId && !c.dueDate);
  if (dateless) {
    out.push({
      urgent: false,
      text: `“${dateless.title}” has a vendor but no date — pick one`,
      hash: '#/tasks',
      go: 'Tasks',
    });
  }

  // 5. Tomorrow's appointments → no surprises.
  for (const a of appointments.filter((x) => x.date === addDays(today, 1)).slice(0, 2)) {
    out.push({
      urgent: false,
      text: `Tomorrow: ${a.title}${a.startTime ? ` at ${a.startTime}` : ''}${a.who ? ` (${a.who})` : ''}`,
      hash: `#/calendar/day/${a.date}`,
      go: 'Calendar',
    });
  }

  return out.slice(0, 4);
}

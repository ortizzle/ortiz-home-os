// suggest.js — the deterministic rule engine. Pure: takes household state,
// returns suggestion objects for Home to render. v1 smart = rules, not AI —
// it should feel attentive, not clever. Calendar-driven triggers arrive in
// v1.5; a Claude-powered advisor is a v2 decision.

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Is today or tomorrow an errand day? Returns null, 'today', or 'tomorrow'.
export function errandWindow(settings) {
  const days = settings.errandDays || [6]; // default: Saturday
  const now = new Date();
  if (days.includes(now.getDay())) return 'today';
  if (days.includes((now.getDay() + 1) % 7)) return 'tomorrow';
  return null;
}

export function buildSuggestions({ chores = [], groceries = [], appointments = [], settings = {} }) {
  const out = [];
  const openGroceries = groceries.filter((g) => !g.gotAt);

  // Errand day + open grocery items → the Costco nudge.
  const win = errandWindow(settings);
  if (win && openGroceries.length) {
    out.push({
      urgent: false,
      text: `${DAY_NAMES[new Date().getDay() + (win === 'tomorrow' ? 1 : 0)] || 'Errand day'} is errand day ${win} — ${openGroceries.length} item${openGroceries.length === 1 ? '' : 's'} on the list`,
      hash: '#/grocery',
      go: 'View list',
    });
  }

  return out.slice(0, 4);
}

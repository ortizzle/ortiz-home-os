// dashboard.js — Home: the household's shared "today". Suggestions from the
// rule engine, the errand-day banner, today's chores + appointments, an
// upkeep snapshot, and quick capture. Counts and due-dates only — no
// streaks, no scores (a household app that scores spouses is a divorce app).

import { getAll, put, getSettings } from './store.js';
import { el, clear, navigate, todayStr, addDays, fmtDay } from './ui.js';
import { choreRow } from './chores.js';
import { addGroceryItem } from './grocery.js';
import { getMaintenance } from './maintenance.js';
import { editAppointmentModal, appointmentsFor } from './calendar.js';
import { analyzeDay, hasApiKey, AIError } from './ai.js';
import { gatherContext, DEFAULT_HOUSEHOLD_NOTES, DEFAULT_KIDS, pinsFor, removePin, logShownSuggestions } from './hmcontext.js';
import { addButtons } from './manager.js';
import { buildSuggestions, errandWindow } from './suggest.js';

const CART_SVG = '<svg viewBox="0 0 24 24"><path d="M3.5 4.5H6l2.3 10.5h9.4l2.3-8.5H7"/><circle cx="9.5" cy="19" r="1.5"/><circle cx="16.5" cy="19" r="1.5"/></svg>';
const BRIEF_KEY = 'ohos.dayBrief';
let briefInFlight = false;

function greeting() {
  const h = new Date().getHours();
  const part = h < 5 ? 'night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
  const name = (getSettings().deviceName || '').trim();
  return `Good ${part}${name ? ', ' + name : ''}`;
}

export async function renderDashboard(root) {
  clear(root);
  const rerender = () => renderDashboard(root);
  const today = todayStr();
  const settings = getSettings();

  const tomorrow = addDays(today, 1);
  const [chores, groceries, apptsWeek, maintenance, vendors] = await Promise.all([
    getAll('chores'),
    getAll('groceries'),
    appointmentsFor(today, addDays(today, 7)), // next 7 days (live + stored)
    getMaintenance(),
    getAll('vendors'),
  ]);
  const vendorById = Object.fromEntries(vendors.map((v) => [v.id, v]));

  const byTime = (a, b) => ((a.allDay ? '' : a.startTime || '') < (b.allDay ? '' : b.startTime || '') ? -1 : 1);
  const openGroceries = groceries.filter((g) => !g.gotAt);
  const dueToday = chores.filter((c) => c.dueDate === today && !c.done);
  const overdue = chores.filter((c) => c.dueDate && c.dueDate < today && !c.done);
  const todayAppts = apptsWeek.filter((a) => a.date === today).sort(byTime);
  const tomorrowAppts = apptsWeek.filter((a) => a.date === tomorrow).sort(byTime);

  // ----- header + stats: tasks due · grocery items · upcoming events -----
  root.append(
    el('p', { class: 'greeting' }, greeting()),
    el('div', { class: 'stat-row' }, [
      el('button', { class: 'stat stat-btn', onclick: () => navigate('#/tasks') }, [
        el('div', { class: 'stat-value' }, dueToday.length + overdue.length),
        el('div', { class: 'stat-label' }, 'tasks due'),
      ]),
      el('button', { class: 'stat stat-btn', onclick: () => navigate('#/grocery') }, [
        el('div', { class: 'stat-value' }, openGroceries.length),
        el('div', { class: 'stat-label' }, 'grocery items'),
      ]),
      el('button', { class: 'stat stat-btn', onclick: () => navigate('#/calendar') }, [
        el('div', { class: 'stat-value' }, apptsWeek.length),
        el('div', { class: 'stat-label' }, 'upcoming events'),
      ]),
    ])
  );

  // ----- errand-day banner (the store-run moment) -----
  const win = errandWindow(settings);
  if (win && openGroceries.length) {
    // Break the count down by store so you know where you're headed.
    const byStore = {};
    for (const g of openGroceries) {
      const s = g.store || 'Costco';
      byStore[s] = (byStore[s] || 0) + 1;
    }
    const breakdown = Object.entries(byStore).map(([s, n]) => `${s} ${n}`).join(' · ');
    root.append(
      el('button', { class: 'errand-banner', onclick: () => navigate('#/grocery') }, [
        el('div', { class: 'errand-title', html: CART_SVG + `<span>Grocery run ${win} — ${openGroceries.length} item${openGroceries.length === 1 ? '' : 's'}</span>` }),
        el('p', { class: 'errand-items' }, breakdown),
      ])
    );
  }

  // ----- suggestions (instant, rule-based) -----
  const suggestions = buildSuggestions({ maintenance, chores, groceries, appointments: apptsWeek, settings })
    // the banner already covers the errand rule when it fires
    .filter((s) => !(win && s.hash === '#/grocery'));
  if (suggestions.length) {
    root.append(
      el('div', { class: 'suggestions' }, suggestions.map((s) =>
        el('button', { class: 'suggestion' + (s.urgent ? ' urgent' : ''), onclick: () => navigate(s.hash) }, [
          el('span', {}, s.text),
          el('span', { class: 'suggestion-go' }, s.go + ' →'),
        ])
      ))
    );
  }

  // ----- daily brief (Claude, auto once each morning) -----
  root.append(...dailyBriefSection(rerender, { today, settings }));

  // ----- quick capture -----
  let kind = 'chore';
  const input = el('input', { class: 'input', placeholder: 'Add a chore for today…' });
  const kindBtn = (k, label, placeholder) =>
    el('button', {
      class: 'btn seg-btn' + (kind === k ? ' active' : ''),
      onclick: (e) => {
        kind = k;
        input.placeholder = placeholder;
        e.currentTarget.parentElement.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b === e.currentTarget));
      },
    }, label);

  async function capture() {
    const text = input.value.trim();
    if (!text) return;
    if (kind === 'chore') {
      // Quick chores land due-today so they show up immediately below.
      await put('chores', { title: text, dueDate: today, done: false });
    } else if (kind === 'grocery') {
      await addGroceryItem(text);
    } else {
      editAppointmentModal(null, today, rerender, { title: text });
      return; // modal flow re-renders on save
    }
    input.value = '';
    rerender();
  }
  input.addEventListener('keydown', (e) => e.key === 'Enter' && capture());

  root.append(
    el('section', { class: 'panel' }, [
      el('h4', {}, 'Quick capture'),
      el('div', { class: 'capture-kind' }, [
        kindBtn('chore', 'Chore', 'Add a chore for today…'),
        kindBtn('grocery', 'Grocery', 'Add to the grocery list…'),
        kindBtn('appt', 'Appointment', 'Appointment title, then details…'),
      ]),
      el('div', { class: 'capture-row' }, [
        input,
        el('button', { class: 'btn btn-primary', onclick: capture }, 'Add'),
      ]),
    ])
  );

  // ----- today (events sorted by time, then chores) -----
  const todayList = [...overdue, ...dueToday];
  root.append(
    el('div', { class: 'panel-head' }, [
      el('h4', {}, 'Today'),
      el('button', { class: 'link', onclick: () => navigate('#/calendar') }, 'Calendar →'),
    ]),
    el('section', { class: 'panel' }, [
      ...todayAppts.map((a) => apptRow(a, rerender)),
      ...todayList.map((c) => choreRow(c, { onchange: rerender, vendorById })),
      !todayAppts.length && !todayList.length
        ? el('p', { class: 'muted small' }, 'Clear day. Capture something above, or enjoy it.')
        : null,
    ])
  );

  // ----- tomorrow (events, sorted by time) -----
  if (tomorrowAppts.length) {
    root.append(
      el('div', { class: 'panel-head' }, [
        el('h4', {}, 'Tomorrow'),
        el('button', { class: 'link', onclick: () => navigate(`#/calendar/day/${tomorrow}`) }, `${fmtDay(tomorrow)} →`),
      ]),
      el('section', { class: 'panel' }, tomorrowAppts.map((a) => apptRow(a, rerender)))
    );
  }
}

// ---------- helpers ----------

function to12(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

// One appointment row: live Google events open in Google; app appointments
// open the in-app editor; all-day events get the highlight class.
function apptRow(a, rerender) {
  return el('div', {
    class: 'event-row' + (a.allDay ? ' all-day' : ''),
    onclick: () =>
      a.source === 'gcal'
        ? (a.htmlLink ? window.open(a.htmlLink, '_blank', 'noopener') : null)
        : editAppointmentModal(a, a.date, rerender),
  }, [
    el('span', { class: 'event-time' }, a.allDay || !a.startTime ? 'All day' : to12(a.startTime)),
    el('span', { class: 'event-title' }, [a.title, a.who ? el('span', { class: 'event-who' }, `· ${a.who}`) : null]),
  ]);
}

// The Home daily brief: a short read on TODAY that generates automatically on
// the first open of the day (cached until tomorrow), with a Refresh, and
// suggestions you can add with one tap.
function dailyBriefSection(rerender, { today, settings }) {
  const host = el('div', {});
  const refresh = el('button', { class: 'link', onclick: () => runBrief(host, rerender, { today, settings, force: true }) }, 'Refresh');

  const cached = readBrief();
  if (cached && cached.date === today) {
    renderBrief(host, cached.data, rerender, new Set(cached.added || []));
  } else if (hasApiKey()) {
    runBrief(host, rerender, { today, settings }); // auto-generate for the day
  } else {
    host.append(...pinNodes(today, rerender));
    host.append(el('p', { class: 'muted small' }, 'Add a Claude API key in Settings and Claudia will read your day each morning — what matters, what to prep, and one-tap add-to-list suggestions.'));
  }

  return [
    el('div', { class: 'panel-head' }, [el('h4', {}, "Claudia's brief"), hasApiKey() ? refresh : null]),
    el('section', { class: 'panel' }, [host]),
  ];
}

async function runBrief(host, rerender, { today, settings, force = false }) {
  if (briefInFlight) return;
  briefInFlight = true;
  clear(host).append(el('div', { class: 'loading' }, [el('div', { class: 'spinner' }), el('span', {}, 'Claudia is reading your day…')]));
  try {
    const ctx = await gatherContext({ start: today, days: 2, email: true });
    const weekday = new Date().toLocaleDateString(undefined, { weekday: 'long' });
    const out = await analyzeDay({
      family: (settings.familyMembers || 'Chris, Kat, Sedona, River').split(',').map((s) => s.trim()).filter(Boolean),
      notes: settings.householdNotes || DEFAULT_HOUSEHOLD_NOTES,
      kids: settings.kidsAges || DEFAULT_KIDS,
      today,
      weekday,
      events: ctx.eventsText,
      chores: ctx.choresText,
      upkeep: ctx.upkeepText,
      groceries: ctx.groceriesText,
      meals: ctx.mealsText,
      email: ctx.emailsText,
    });
    logShownSuggestions(out.suggestions, 'brief').catch(() => {});
    writeBrief(today, out);
    renderBrief(host, out, rerender, new Set());
  } catch (err) {
    clear(host).append(
      el('p', { class: 'muted small' }, err instanceof AIError ? err.message : `Couldn't generate today's brief: ${err.message}`),
      el('button', { class: 'btn', style: 'margin-top: 8px', onclick: () => runBrief(host, rerender, { today, settings, force: true }) }, 'Try again')
    );
  } finally {
    briefInFlight = false;
  }
}

// Notes pinned from the Manager's "Ask" — shown at the top of the brief until
// the family dismisses them. Per-device (localStorage), like the brief cache.
function pinNodes(today, rerender) {
  return pinsFor(today).map((p) =>
    el('div', { class: 'brief-pin' }, [
      el('span', {}, p.text),
      el('button', { class: 'link', 'aria-label': 'Dismiss', onclick: () => { removePin(p.id); rerender(); } }, '×'),
    ])
  );
}

function renderBrief(host, out, rerender, addedSet = new Set()) {
  clear(host);
  host.append(...pinNodes(todayStr(), rerender));
  if (out.headline) host.append(el('p', { class: 'brief-headline' }, out.headline));
  if (out.notes?.length) host.append(el('ul', { class: 'brief-notes' }, out.notes.map((n) => el('li', {}, n))));
  for (const s of out.suggestions || []) {
    host.append(
      el('div', { class: 'idea' }, [
        el('div', { class: 'idea-title' }, [s.title, s.who ? el('span', { class: 'pill pill-accent', style: 'margin-left: 6px' }, s.who) : null]),
        s.detail ? el('p', { class: 'idea-detail' }, s.detail) : null,
        addButtons(s, {
          today: todayStr(),
          includePlan: false,
          alreadyAdded: addedSet.has(s.title),
          // Persist the Added ✓ state so the re-render (which refreshes the
          // Today list below) restores it instead of re-arming the button.
          onAdded: () => { markBriefAdded(s.title); rerender(); },
        }),
      ])
    );
  }
  if (!out.headline && !out.notes?.length && !out.suggestions?.length) host.append(el('p', { class: 'muted small' }, 'Nothing pressing today — enjoy it.'));
}

function readBrief() { try { return JSON.parse(localStorage.getItem(BRIEF_KEY)); } catch { return null; } }
function writeBrief(date, data) { localStorage.setItem(BRIEF_KEY, JSON.stringify({ date, data, added: [] })); }
function markBriefAdded(title) {
  const b = readBrief();
  if (!b) return;
  b.added = [...new Set([...(b.added || []), title])];
  localStorage.setItem(BRIEF_KEY, JSON.stringify(b));
}

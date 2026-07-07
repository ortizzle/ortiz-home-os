// dashboard.js — Home: the household's shared "today". Suggestions from the
// rule engine, the errand-day banner, today's chores + appointments, an
// upkeep snapshot, and quick capture. Counts and due-dates only — no
// streaks, no scores (a household app that scores spouses is a divorce app).

import { getAll, put, getSettings } from './store.js';
import { el, clear, navigate, todayStr, addDays, fmtDay } from './ui.js';
import { choreRow, editChoreModal, toggleChore } from './chores.js';
import { addGroceryItem, STORES } from './grocery.js';
import { getMaintenance, nextDue, dueState } from './maintenance.js';
import { editAppointmentModal, appointmentsFor } from './calendar.js';
import { isConnected, eventsForRange } from './gcal.js';
import { reviewHousehold, hasApiKey, AIError } from './ai.js';
import { buildSuggestions, errandWindow } from './suggest.js';

const CART_SVG = '<svg viewBox="0 0 24 24"><path d="M3.5 4.5H6l2.3 10.5h9.4l2.3-8.5H7"/><circle cx="9.5" cy="19" r="1.5"/><circle cx="16.5" cy="19" r="1.5"/></svg>';

// The family's shopping habits etc., fed to the house-manager AI. Editable in
// Settings → "Notes for the assistant"; this is the default seed.
export const DEFAULT_HOUSEHOLD_NOTES =
  "Shopping habits: Costco — go during executive hours right when it opens (weekend mornings). Trader Joe's — quick, local runs for a few items. Walmart — usually home delivery, for items we don't want in Costco bulk sizes.";

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
  const [chores, groceries, appts2day, maintenance, vendors] = await Promise.all([
    getAll('chores'),
    getAll('groceries'),
    appointmentsFor(today, addDays(today, 2)), // today + tomorrow (live + stored)
    getMaintenance(),
    getAll('vendors'),
  ]);
  const vendorById = Object.fromEntries(vendors.map((v) => [v.id, v]));

  const byTime = (a, b) => ((a.allDay ? '' : a.startTime || '') < (b.allDay ? '' : b.startTime || '') ? -1 : 1);
  const openGroceries = groceries.filter((g) => !g.gotAt);
  const dueToday = chores.filter((c) => c.dueDate === today && !c.done);
  const overdue = chores.filter((c) => c.dueDate && c.dueDate < today && !c.done);
  const todayAppts = appts2day.filter((a) => a.date === today).sort(byTime);
  const tomorrowAppts = appts2day.filter((a) => a.date === tomorrow).sort(byTime);
  const overdueUpkeep = maintenance.filter((m) => dueState(m) === 'overdue');

  // ----- header + stats -----
  root.append(
    el('p', { class: 'greeting' }, greeting()),
    el('div', { class: 'stat-row' }, [
      el('button', { class: 'stat stat-btn', onclick: () => navigate('#/grocery') }, [
        el('div', { class: 'stat-value' }, openGroceries.length),
        el('div', { class: 'stat-label' }, 'grocery items'),
      ]),
      el('button', { class: 'stat stat-btn', onclick: () => navigate('#/tasks') }, [
        el('div', { class: 'stat-value' }, dueToday.length + overdue.length),
        el('div', { class: 'stat-label' }, 'chores due'),
      ]),
      el('button', { class: 'stat stat-btn', onclick: () => navigate('#/upkeep') }, [
        el('div', { class: 'stat-value' }, overdueUpkeep.length),
        el('div', { class: 'stat-label' }, 'upkeep overdue'),
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
  const suggestions = buildSuggestions({ maintenance, chores, groceries, appointments: appts2day, settings })
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

  // ----- house manager (Claude) -----
  root.append(...houseManagerSection(rerender, { today, family: (settings.familyMembers || 'Chris, Kat, Sedona, River'), notes: settings.householdNotes || DEFAULT_HOUSEHOLD_NOTES, chores, maintenance, groceries }));

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

// The Claude house-manager panel: on demand, reviews the coming ~2 weeks of
// calendar + household state and surfaces proactive ideas.
function houseManagerSection(rerender, ctx) {
  const host = el('div', {});
  const btn = el('button', {
    class: 'btn btn-primary full',
    style: 'margin-bottom: 6px',
    onclick: async () => {
      if (!hasApiKey()) { navigate('#/settings'); return; }
      btn.disabled = 'disabled';
      btn.textContent = 'Thinking…';
      clear(host).append(el('div', { class: 'loading' }, [el('div', { class: 'spinner' }), el('span', {}, 'Reviewing your week…')]));
      try {
        const events = isConnected() ? await eventsForRange(ctx.today, addDays(ctx.today, 14)).catch(() => []) : [];
        const eventsText = events
          .sort((a, b) => (a.date + (a.startTime || '') < b.date + (b.startTime || '') ? -1 : 1))
          .map((e) => `- ${fmtDay(e.date)}${e.startTime ? ' ' + to12(e.startTime) : ' (all day)'}: ${e.title}`)
          .join('\n');
        const choresText = ctx.chores.filter((c) => !c.done).map((c) => `- ${c.title}${c.dueDate ? ` (due ${c.dueDate})` : ''}`).join('\n');
        const upkeepText = ctx.maintenance.filter((m) => dueState(m) !== 'ok').map((m) => `- ${m.title} (due ${nextDue(m)})`).join('\n');
        const byStore = {};
        for (const g of ctx.groceries.filter((x) => !x.gotAt)) { const s = g.store || STORES[0]; (byStore[s] ||= []).push(g.name); }
        const groceriesText = Object.entries(byStore).map(([s, names]) => `${s}: ${names.join(', ')}`).join('\n');

        const out = await reviewHousehold({
          family: ctx.family.split(',').map((s) => s.trim()).filter(Boolean),
          notes: ctx.notes,
          today: ctx.today,
          events: eventsText,
          chores: choresText,
          upkeep: upkeepText,
          groceries: groceriesText,
        });
        renderHouseIdeas(host, out);
      } catch (err) {
        clear(host).append(el('p', { class: 'muted small' }, err instanceof AIError ? err.message : `Something went wrong: ${err.message}`));
      } finally {
        btn.disabled = null;
        btn.textContent = 'Review the week';
      }
    },
  }, 'Review the week');

  const hint = !hasApiKey()
    ? 'Add a Claude API key in Settings to get proactive ideas from your week — birthdays to prep for, appointments to get ahead of, good times to run errands.'
    : (isConnected() ? 'Claude reviews your calendar and lists and flags what to get ahead of.' : 'Connect Google Calendar in Settings so Claude can see the week, then review.');

  return [
    el('div', { class: 'panel-head' }, [el('h4', {}, 'House manager')]),
    el('section', { class: 'panel' }, [
      el('p', { class: 'muted small', style: 'margin-top:0' }, hint),
      btn,
      host,
    ]),
  ];
}

function renderHouseIdeas(host, out) {
  clear(host);
  for (const i of out.ideas || []) {
    host.append(
      el('div', { class: 'idea' }, [
        el('div', { class: 'idea-title' }, i.title),
        i.detail ? el('p', { class: 'idea-detail' }, i.detail) : null,
        i.actions?.length ? el('ul', { class: 'idea-actions' }, i.actions.map((a) => el('li', {}, a))) : null,
      ])
    );
  }
  if (out.questions?.length) {
    host.append(
      el('div', { class: 'idea-questions' }, [
        el('h5', {}, 'Claude wants to know'),
        el('ul', { class: 'idea-actions' }, out.questions.map((q) => el('li', {}, q))),
      ])
    );
  }
  if (!host.children.length) host.append(el('p', { class: 'muted small' }, 'Nothing pressing came up for the week ahead.'));
}

// dashboard.js — Home: the household's shared "today". Suggestions from the
// rule engine, the errand-day banner, today's chores + appointments, an
// upkeep snapshot, and quick capture. Counts and due-dates only — no
// streaks, no scores (a household app that scores spouses is a divorce app).

import { getAll, put, getSettings } from './store.js';
import { el, clear, navigate, todayStr, addDays } from './ui.js';
import { choreRow, editChoreModal, toggleChore } from './chores.js';
import { addGroceryItem } from './grocery.js';
import { getMaintenance, nextDue, maintenanceRow, dueState } from './maintenance.js';
import { editAppointmentModal } from './calendar.js';
import { buildSuggestions, errandWindow } from './suggest.js';

const CART_SVG = '<svg viewBox="0 0 24 24"><path d="M3.5 4.5H6l2.3 10.5h9.4l2.3-8.5H7"/><circle cx="9.5" cy="19" r="1.5"/><circle cx="16.5" cy="19" r="1.5"/></svg>';

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

  const [chores, groceries, appointments, maintenance, vendors] = await Promise.all([
    getAll('chores'),
    getAll('groceries'),
    getAll('appointments'),
    getMaintenance(),
    getAll('vendors'),
  ]);
  const vendorById = Object.fromEntries(vendors.map((v) => [v.id, v]));

  const openGroceries = groceries.filter((g) => !g.gotAt);
  const dueToday = chores.filter((c) => c.dueDate === today && !c.done);
  const overdue = chores.filter((c) => c.dueDate && c.dueDate < today && !c.done);
  const todayAppts = appointments
    .filter((a) => a.date === today)
    .sort((a, b) => ((a.startTime || '') < (b.startTime || '') ? -1 : 1));
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

  // ----- suggestions -----
  const suggestions = buildSuggestions({ maintenance, chores, groceries, appointments, settings })
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

  // ----- today -----
  const todayList = [...overdue, ...dueToday];
  root.append(
    el('div', { class: 'panel-head' }, [
      el('h4', {}, 'Today'),
      el('button', { class: 'link', onclick: () => navigate('#/calendar') }, 'Calendar →'),
    ]),
    el('section', { class: 'panel' }, [
      ...todayAppts.map((a) =>
        el('div', { class: 'event-row', onclick: () => editAppointmentModal(a, today, rerender) }, [
          el('span', { class: 'event-time' }, a.allDay || !a.startTime ? 'All day' : a.startTime),
          el('span', { class: 'event-title' }, [a.title, a.who ? el('span', { class: 'event-who' }, `· ${a.who}`) : null]),
        ])
      ),
      ...todayList.map((c) => choreRow(c, { onchange: rerender, vendorById })),
      !todayAppts.length && !todayList.length
        ? el('p', { class: 'muted small' }, 'Clear day. Capture something above, or enjoy it.')
        : null,
    ])
  );

  // ----- upkeep snapshot: next three due -----
  const upcoming = maintenance.slice(0, 3);
  if (upcoming.length) {
    root.append(
      el('div', { class: 'panel-head' }, [
        el('h4', {}, 'Upkeep'),
        el('button', { class: 'link', onclick: () => navigate('#/upkeep') }, 'All upkeep →'),
      ]),
      el('section', { class: 'panel' }, upcoming.map((it) => maintenanceRow(it, { onchange: rerender, vendorById })))
    );
  }
}

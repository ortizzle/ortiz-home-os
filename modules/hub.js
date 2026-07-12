// hub.js — the suite hub: one "today" surface across all of Ortiz OS
// (ROADMAP Phase 2, in ortiz-focus-os). Home OS hosts the view; Learning OS
// and Focus OS are read same-origin through siblings.js, strictly read-only —
// tap any row and you jump into the app that owns it.

import { getAll } from './store.js';
import { el, clear, navigate, todayStr, fmtDue, preserveScroll } from './ui.js';
import { choreRow } from './chores.js';
import { appointmentsFor } from './calendar.js';
import { siblings, focusToday, learningToday } from './siblings.js';

const openApp = (path, hash = '') => (location.href = path + hash);

export async function renderHub(root) {
  clear(root);
  const rerender = preserveScroll(() => renderHub(root));
  const today = todayStr();

  const [focus, learning, chores, appts] = await Promise.all([
    focusToday(),
    learningToday(),
    getAll('chores'),
    appointmentsFor(today, today),
  ]);

  const choresDue = chores.filter((c) => !c.done && c.dueDate && c.dueDate <= today);

  root.append(
    el('div', { class: 'view-head' }, [el('h1', {}, 'Ortiz OS')]),
    el('p', { class: 'muted small', style: 'margin: -6px 0 14px' },
      'Your whole day, across the suite. Learning and Focus are read-only here — tap through to act on them.')
  );

  // ----- suite stats -----
  root.append(
    el('div', { class: 'stat-row' }, [
      el('button', { class: 'stat stat-btn', onclick: () => (learning ? openApp('/deep-learning-os/') : null) }, [
        el('div', { class: 'stat-value' }, learning ? `${learning.items.filter((t) => t.status === 'done').length}/${learning.items.length}` : '—'),
        el('div', { class: 'stat-label' }, 'learning list'),
      ]),
      el('button', { class: 'stat stat-btn', onclick: () => (focus ? openApp('/ortiz-focus-os/', '#/timer') : null) }, [
        el('div', { class: 'stat-value' }, focus ? focus.minFocused : '—'),
        el('div', { class: 'stat-label' }, 'min focused'),
      ]),
      el('button', { class: 'stat stat-btn', onclick: () => navigate('#/tasks') }, [
        el('div', { class: 'stat-value' }, choresDue.length),
        el('div', { class: 'stat-label' }, 'home tasks due'),
      ]),
    ])
  );

  // ----- Learning OS -----
  root.append(...learningSection(learning));

  // ----- Focus OS -----
  root.append(...focusSection(focus));

  // ----- Home OS (host — its rows stay live) -----
  root.append(
    el('div', { class: 'panel-head' }, [
      el('h4', {}, 'Home'),
      el('button', { class: 'link', onclick: () => navigate('#/home') }, 'Home tab →'),
    ]),
    el('section', { class: 'panel' }, [
      ...appts
        .sort((a, b) => ((a.allDay ? '' : a.startTime || '') < (b.allDay ? '' : b.startTime || '') ? -1 : 1))
        .map((a) =>
          el('div', { class: 'event-row' + (a.allDay ? ' all-day' : ''), onclick: () => navigate('#/calendar') }, [
            el('span', { class: 'event-time' }, a.allDay || !a.startTime ? 'All day' : a.startTime),
            el('span', { class: 'event-title' }, [a.title, a.who ? el('span', { class: 'event-who' }, `· ${a.who}`) : null]),
          ])
        ),
      ...choresDue.map((c) => choreRow(c, { onchange: rerender })),
      !appts.length && !choresDue.length
        ? el('p', { class: 'muted small' }, 'Nothing due at home today.')
        : null,
    ])
  );
}

// Panel body shown when a sibling app has never run on this origin — its
// database simply isn't here (each device/browser has its own IndexedDB).
function notHereYet(app) {
  return el('section', { class: 'panel' }, [
    el('p', { class: 'muted small' }, [
      `No ${app.name} data on this device yet. `,
      el('a', { class: 'link', href: app.path }, `Open ${app.name} once`),
      ' and its day will show up here.',
    ]),
  ]);
}

function learningSection(learning) {
  const app = siblings.find((a) => a.id === 'dlos');
  const head = el('div', { class: 'panel-head' }, [
    el('h4', {}, 'Learning'),
    el('button', { class: 'link', onclick: () => openApp(app.path) }, 'Open →'),
  ]);
  if (!learning) return [head, notHereYet(app)];

  const statusPill = (t) =>
    t.status === 'done'
      ? el('span', { class: 'pill pill-done' }, 'done')
      : t.status === 'skipped'
        ? el('span', { class: 'pill' }, 'skipped')
        : null;

  return [
    head,
    el('section', { class: 'panel' }, [
      summaryLine([
        learning.streak ? `${learning.streak}-day streak` : null,
        learning.lessonsDoneToday ? `${learning.lessonsDoneToday} lesson${learning.lessonsDoneToday === 1 ? '' : 's'} completed today` : null,
      ]),
      ...learning.items.map((t) =>
        el('div', { class: 'task-row' + (t.status === 'done' ? ' done' : ''), onclick: () => openApp(app.path, '#/dashboard') }, [
          el('div', { class: 'task-main' }, [
            el('span', { class: 'task-name' }, t.name),
            el('span', { class: 'task-meta' }, [
              t.type === 'habit' ? el('span', { class: 'pill pill-accent' }, 'habit') : null,
              statusPill(t),
            ]),
          ]),
        ])
      ),
      !learning.items.length
        ? el('p', { class: 'muted small' }, 'Nothing on the learning list today.')
        : null,
    ]),
  ];
}

function focusSection(focus) {
  const app = siblings.find((a) => a.id === 'ofos');
  const head = el('div', { class: 'panel-head' }, [
    el('h4', {}, 'Focus'),
    el('button', { class: 'link', onclick: () => openApp(app.path) }, 'Open →'),
  ]);
  if (!focus) return [head, notHereYet(app)];

  return [
    head,
    el('section', { class: 'panel' }, [
      summaryLine([
        focus.streak ? `${focus.streak}-day streak` : null,
        `${focus.doneToday} task${focus.doneToday === 1 ? '' : 's'} done today`,
        focus.minFocused ? `${focus.minFocused} min focused` : null,
      ]),
      ...focus.due.map((t) =>
        el('div', { class: 'task-row', onclick: () => openApp(app.path, '#/tasks') }, [
          el('div', { class: 'task-main' }, [
            el('span', { class: 'task-name' }, t.title),
            el('span', { class: 'task-meta' }, [
              el('span', { class: 'pill' + (t.dueDate < focus.today ? ' pill-overdue' : '') }, fmtDue(t.dueDate)),
              t.priority ? el('span', { class: 'pill pill-accent' }, t.priority) : null,
            ]),
          ]),
        ])
      ),
      !focus.due.length
        ? el('p', { class: 'muted small' }, focus.openCount ? 'Nothing due today — the rest can wait.' : 'No open tasks at all. Enjoy it.')
        : null,
    ]),
  ];
}

function summaryLine(parts) {
  const live = parts.filter(Boolean);
  if (!live.length) return null;
  return el('p', { class: 'muted small', style: 'margin: 0 0 8px' }, live.join(' · '));
}

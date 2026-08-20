// twoweeks.js — the "2 Weeks" tab: the next 14 days as a planning hub.
// Three stacked pieces, per the family's design:
//   1. A deterministic summary (counts + exams + birthdays + rhythm) — rules,
//      not AI, so it's instant and always there.
//   2. A tappable month calendar — dots mark days with something on (amber =
//      school exam); tapping a date shows that day's details inline.
//   3. The rundown: This week / Next week as collapsible sections, collapsed
//      by default (the summary + grid already carry the shape of the window).
// Each stat pill in the summary (exam/task/birthday/event) is also a
// spotlight toggle: tap one and every mention of that category highlights
// together — the summary line, the matching calendar days, and the matching
// rundown rows (see CAT_COLOR + matchesCat/toggleSpotlight below).
// Replaced the Grocery tab in v79. Read-only glance view — capture and
// editing stay on Home / Tasks / Calendar.

import { getAll, getSettings } from './store.js';
import { el, clear, navigate, todayStr, addDays, parseDate, fmtDay, ownerPillClass, preserveScroll } from './ui.js';
import { appointmentsFor, spansDay } from './calendar.js';
import { householdKnowledge, upcomingBirthdays, calendarBirthdays, mergeBirthdays } from './hmcontext.js';
import { schoolConfigured, getSchoolSummaries } from './school.js';
import { getLastCalendarIssues } from './gcal.js';

const WINDOW_DAYS = 14;
const DOW = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
// Which color group each spotlight category uses — 'warn' (amber) for
// time-pressure items, 'accent' (blue) for calendar-shaped ones. Shared by
// every panel below so tapping a stat pill lights up its mentions
// consistently across the summary, the grid, and the rundown.
const CAT_COLOR = { exam: 'warn', task: 'warn', birthday: 'accent', event: 'accent' };

function to12h(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

// Per-device UI state: which date is selected on the grid, which month is
// shown, and which week sections are open. Survives re-renders, not reloads.
const state = { selected: null, monthOf: null, openWeeks: new Set(), spotlight: null };

export async function renderTwoWeeks(root) {
  clear(root);
  const today = todayStr();
  const end = addDays(today, WINDOW_DAYS); // exclusive
  if (!state.selected || state.selected < today || state.selected >= end) state.selected = today;
  if (!state.monthOf) state.monthOf = state.selected.slice(0, 7);
  // Every generic rerender (month nav, etc.) is a full clear+rebuild, so
  // without this it drops you back at the top of the page each time —
  // preserveScroll restores exactly where you were. The date-tap handler
  // below layers its own intentional scroll (to the selected day) on top.
  const rerender = preserveScroll(() => renderTwoWeeks(root));

  const settings = getSettings();
  const family = (settings.familyMembers || 'Chris, Kat, Sedona, River').split(',').map((s) => s.trim()).filter(Boolean);
  const [appts, chores, school, knowledge] = await Promise.all([
    appointmentsFor(today, end),
    getAll('chores'),
    schoolConfigured() ? getSchoolSummaries().catch(() => null) : null,
    householdKnowledge(settings),
  ]);

  const dueTasks = chores
    .filter((c) => !c.done && c.dueDate && c.dueDate >= today && c.dueDate < end)
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));
  // Every school item in the window, tagged with the kid it belongs to.
  const exams = (school?.kids || []).flatMap((k) =>
    (k.upcoming || [])
      .filter((u) => u.date >= today && u.date < end)
      .map((u) => ({ ...u, kid: k.name }))
  ).sort((a, b) => a.date.localeCompare(b.date));
  const birthdays = mergeBirthdays(
    upcomingBirthdays(knowledge, today, WINDOW_DAYS - 1),
    calendarBirthdays(appts, today, WINDOW_DAYS - 1)
  );

  const days = Array.from({ length: WINDOW_DAYS }, (_, i) => addDays(today, i));
  const eventsOn = (d) => appts.filter((a) => spansDay(a, d)).sort((a, b) => ((a.allDay ? '' : a.startTime || '') < (b.allDay ? '' : b.startTime || '') ? -1 : 1));
  const tasksOn = (d) => dueTasks.filter((c) => c.dueDate === d);
  const examsOn = (d) => exams.filter((x) => x.date === d);
  const dayHasAnything = (d) => eventsOn(d).length || tasksOn(d).length || examsOn(d).length;

  // Tap a stat pill (exam/task/birthday/event) to spotlight every mention of
  // that category — the summary line, the matching calendar days, and the
  // matching rundown rows all light up together. Tap again to clear.
  const matchesCat = (d, cat) => {
    if (cat === 'exam') return examsOn(d).length > 0;
    if (cat === 'task') return tasksOn(d).length > 0;
    if (cat === 'birthday') return birthdays.some((b) => b.date === d);
    // 'event' excludes birthday-titled appointments — a birthday is a real
    // calendar event too, but it spotlights under "birthday" (see dayRows'
    // same split), never both, so the calendar ring always agrees with which
    // row actually lit up.
    if (cat === 'event') return eventsOn(d).some((a) => !/\bbirthday\b/i.test(a.title || ''));
    return false;
  };
  const toggleSpotlight = (cat) => { state.spotlight = state.spotlight === cat ? null : cat; rerender(); };
  const spotlight = state.spotlight;

  root.append(el('header', { class: 'view-head' }, [
    el('h1', {}, '2 Weeks'),
    el('p', { class: 'muted small', style: 'margin: 2px 0 0' }, 'The next 14 days at a glance — exams and plans to get ahead of.'),
  ]));

  // A calendar this device's Google account can't read gets silently skipped
  // deep in gcal.js — no error, just fewer events than actually exist, with
  // nothing pointing at why. Surface it here instead of leaving it a mystery.
  const calIssues = getLastCalendarIssues();
  if (calIssues.length) {
    root.append(el('div', { class: 'panel', style: 'background: var(--warn-soft); border-color: var(--warn); margin-bottom: 14px;' }, [
      el('p', { class: 'small', style: 'margin: 0; color: var(--warn); font-weight: 600;' }, `Couldn't read events from: ${calIssues.map((i) => i.name).join(', ')}`),
      el('p', { class: 'small', style: 'margin: 4px 0 0; color: var(--text-2);' }, 'That calendar may not be shared with this device’s Google account, or the share was never accepted. Events on it won’t show anywhere in the app until that’s fixed on Google’s side.'),
    ]));
  }

  root.append(summaryPanel({ appts, dueTasks, exams, birthdays, today, spotlight, toggleSpotlight }));
  root.append(calendarPanel({ today, end, eventsOn, tasksOn, examsOn, dayHasAnything, family, rerender, spotlight, matchesCat }));
  root.append(...weekSections({ today, days, eventsOn, tasksOn, examsOn, exams, birthdays, family, rerender, spotlight, matchesCat }));
}

// ---------- 1) summary ----------

function summaryPanel({ appts, dueTasks, exams, birthdays, today, spotlight, toggleSpotlight }) {
  const eventCount = new Set(appts.map((a) => a.seriesId || a.id)).size;
  // Each pill doubles as a spotlight toggle — tap "2 exams" and every exam
  // mention below (and on the calendar + in the rundown) highlights. A pill
  // with nothing behind it is inert — no mentions to spotlight.
  const stat = (n, label, cat) => {
    const active = spotlight === cat;
    return el('button', {
      class: 'tw-stat' + (active ? ' active c-' + CAT_COLOR[cat] : ''),
      disabled: n === 0 ? 'disabled' : null,
      onclick: n === 0 ? null : () => toggleSpotlight(cat),
    }, `${n} ${label}${n === 1 ? '' : 's'}`);
  };
  // Body is a bulleted list, one line per item — a run-on "Sedona Math · River
  // Reading" sentence reads odd once there's more than one of anything.
  const line = (key, items, cat, cls = '') => el('div', {
    class: 'tw-sum-line' + (cls ? ' ' + cls : '') + (cat && spotlight === cat ? ' spot-' + CAT_COLOR[cat] : ''),
  }, [
    el('span', { class: 'tw-sum-key' + (cls ? ' ' + cls : '') }, key),
    el('ul', { class: 'meeting-list' }, items.map((item) => el('li', {}, item))),
  ]);

  const kids = [];
  if (exams.length) {
    kids.push(line('School', exams.map((x) => [
      el('strong', {}, x.kid), ` ${x.label} — ${fmtDay(x.date)}`,
    ]), 'exam', 'tw-warn'));
  }
  if (birthdays.length) {
    // Its own explicit key (not the vaguer "Plan for") since birthdays are
    // the only thing that ever lands here — same pattern as School's line.
    kids.push(line('Birthdays', birthdays.map((b) => [
      el('strong', {}, b.name), ` — ${fmtDay(b.date)}, get ahead of the gift`,
    ]), 'birthday', 'tw-accent'));
  }
  // The window's recurring beats (a series that lands 2+ times) — collapsed to
  // one mention each so the rhythm reads at a glance. No stat pill maps to
  // this one, so it never spotlights — it's context, not a countable thing.
  const bySeries = new Map();
  for (const a of appts) {
    const key = a.seriesId || 'title:' + (a.title || '').toLowerCase();
    (bySeries.get(key) || bySeries.set(key, []).get(key)).push(a);
  }
  const rhythm = [...bySeries.values()].filter((l) => new Set(l.map((a) => a.date)).size >= 2).map((l) => l[0].title).slice(0, 4);
  if (rhythm.length) kids.push(line('Rhythm', rhythm.map((t) => [t]), null));
  if (!kids.length) kids.push(el('p', { class: 'muted small', style: 'margin: 4px 0 0' }, 'A quiet stretch — nothing that needs lead time.'));

  return el('section', { class: 'panel' }, [
    el('div', { class: 'panel-head' }, [el('h4', {}, 'The next two weeks')]),
    el('div', { class: 'tw-stats' }, [
      stat(eventCount, 'event', 'event'),
      stat(dueTasks.length, 'task', 'task'),
      stat(exams.length, 'exam', 'exam'),
      birthdays.length ? stat(birthdays.length, 'birthday', 'birthday') : null,
    ]),
    ...kids,
  ]);
}

// ---------- 2) month calendar + selected-day details ----------

function calendarPanel({ today, end, eventsOn, tasksOn, examsOn, dayHasAnything, family, rerender, spotlight, matchesCat }) {
  const [yy, mm] = state.monthOf.split('-').map(Number);
  const first = `${state.monthOf}-01`;
  const firstDow = parseDate(first).getDay();
  const daysInMonth = new Date(yy, mm, 0).getDate();
  const monthLabel = parseDate(first).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  // Month nav only spans months the 14-day window touches.
  const monthsInWindow = new Set([today.slice(0, 7), addDays(today, WINDOW_DAYS - 1).slice(0, 7)]);
  const nav = (delta, label) => {
    const target = `${new Date(yy, mm - 1 + delta, 1).getFullYear()}-${String(new Date(yy, mm - 1 + delta, 1).getMonth() + 1).padStart(2, '0')}`;
    if (!monthsInWindow.has(target)) return el('span', { class: 'tw-cal-nav off' }, label);
    return el('button', { class: 'tw-cal-nav', onclick: () => { state.monthOf = target; rerender(); } }, label);
  };

  const cells = [el('div', { class: 'tw-cal-grid' }, DOW.map((d) => el('div', { class: 'tw-cal-dow' }, d)))];
  const grid = [];
  for (let i = 0; i < firstDow; i++) grid.push(el('div', { class: 'tw-cal-cell blank' }));
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${state.monthOf}-${String(d).padStart(2, '0')}`;
    const inWindow = iso >= today && iso < end;
    const cls = ['tw-cal-cell'];
    if (iso === today) cls.push('today');
    if (iso === state.selected) cls.push('sel');
    if (!inWindow) cls.push('out');
    const dots = [];
    if (inWindow) {
      if (examsOn(iso).length) dots.push(el('span', { class: 'tw-dot exam' }));
      if (eventsOn(iso).length || tasksOn(iso).length) dots.push(el('span', { class: 'tw-dot' }));
      // Spotlight active: ring the days that match, dim the ones that don't
      // (but do have something on) so the matches actually stand out.
      if (spotlight) {
        if (matchesCat(iso, spotlight)) cls.push('spot-match', 'c-' + CAT_COLOR[spotlight]);
        else if (dots.length) cls.push('spot-dim');
      }
    }
    grid.push(el(inWindow ? 'button' : 'div', {
      class: cls.join(' '),
      // Jump to the selected-day panel below, not just re-render in place —
      // otherwise tapping a date on the grid leaves you staring at the grid
      // while the details you asked for landed off-screen underneath it.
      ...(inWindow ? { onclick: async () => { state.selected = iso; await rerender(); document.getElementById('tw-selday')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } } : {}),
    }, [el('span', { class: 'tw-cal-num' }, String(d)), dots.length ? el('span', { class: 'tw-dots' }, dots) : null]));
  }
  cells.push(el('div', { class: 'tw-cal-grid' }, grid));

  const sel = state.selected;
  const selRows = dayRows({ date: sel, events: eventsOn(sel), tasks: tasksOn(sel), exams: examsOn(sel), family, spotlight });
  return el('section', { class: 'panel', style: 'margin-top: 14px' }, [
    el('div', { class: 'tw-cal-head' }, [nav(-1, '‹'), el('h4', {}, monthLabel), nav(1, '›')]),
    ...cells,
    // id + toc-anchor: scroll target for the date-tap handler above. Reuses
    // the app's existing scroll-margin-top rule so the sticky topbar doesn't
    // cover the heading when we land here.
    el('div', { class: 'tw-selday toc-anchor', id: 'tw-selday' }, [
      el('h5', {}, sel === today ? `Today · ${fmtDay(sel)}` : fmtDay(sel)),
      ...(selRows.length ? selRows : [el('p', { class: 'muted small', style: 'margin: 4px 0 0' }, 'Nothing scheduled.')]),
      el('a', { class: 'link small', href: `#/calendar/day/${sel}`, style: 'display: inline-block; margin-top: 8px' }, 'Open in Calendar →'),
    ]),
  ]);
}

// ---------- 3) the rundown: collapsible weeks ----------

function weekSections({ today, days, eventsOn, tasksOn, examsOn, exams, birthdays, family, rerender, spotlight, matchesCat }) {
  const weeks = [
    { key: 'w1', title: 'This week', days: days.slice(0, 7) },
    { key: 'w2', title: 'Next week', days: days.slice(7) },
  ];
  return weeks.map((w) => {
    const range = `${fmtDay(w.days[0]).replace(/^\w+, /, '')}–${fmtDay(w.days.at(-1)).replace(/^\w+, /, '')}`;
    const wExams = exams.filter((x) => w.days.includes(x.date)).length;
    const wBdays = birthdays.filter((b) => w.days.includes(b.date)).length;
    const hints = [wExams ? `${wExams} exam${wExams === 1 ? '' : 's'}` : null, wBdays ? 'birthday' : null].filter(Boolean).join(', ');

    const body = [];
    for (const d of w.days) {
      const rows = dayRows({ date: d, events: eventsOn(d), tasks: tasksOn(d), exams: examsOn(d), family, spotlight });
      if (!rows.length) continue; // the grid above already shows quiet days
      body.push(el('div', { class: 'tw-day-sub' }, d === today ? `Today · ${fmtDay(d)}` : fmtDay(d)));
      body.push(...rows);
    }
    if (!body.length) body.push(el('p', { class: 'muted small', style: 'padding: 4px 0 8px' }, 'Nothing scheduled this week yet.'));

    // Tint the week's own summary row when it holds a spotlight match, so a
    // still-collapsed section signals "there's one in here" before you open it.
    const weekHasMatch = spotlight && w.days.some((d) => matchesCat(d, spotlight));
    const det = el('details', { class: 'tw-wk' + (weekHasMatch ? ' spot-' + CAT_COLOR[spotlight] : '') }, [
      el('summary', {}, [
        el('span', {}, [el('span', { class: 'tw-wk-title' }, w.title), ' ', el('span', { class: 'tw-wk-sub' }, hints ? `${range} · ${hints}` : range)]),
        el('span', { class: 'tw-chev' }, '›'),
      ]),
      el('div', { class: 'tw-wk-body' }, body),
    ]);
    if (state.openWeeks.has(w.key)) det.setAttribute('open', 'open');
    det.addEventListener('toggle', () => { det.open ? state.openWeeks.add(w.key) : state.openWeeks.delete(w.key); });
    return det;
  });
}

// ---------- shared row rendering ----------

function dayRows({ date, events, tasks, exams, family, spotlight = null }) {
  const rows = [];
  const rowCls = (base, cat) => base + (spotlight === cat ? ' spot-' + CAT_COLOR[cat] : '');
  for (const x of exams) {
    rows.push(el('div', { class: rowCls('tw-row exam', 'exam') }, [
      el('div', { class: 'tw-time allday' }, 'school'),
      el('div', {}, [
        el('div', { class: 'tw-title' }, `${x.kid} — ${x.label}${x.title ? ` (${x.title})` : ''}`),
        el('div', { class: 'tw-meta' }, [el('span', { class: 'pill pill-soon' }, 'exam'), el('span', { class: 'pill ' + ownerPillClass(x.kid, family) }, x.kid)]),
      ]),
    ]));
  }
  for (const a of events) {
    const who = (a.who || '').split(/[,+&]/).map((s) => s.trim()).filter(Boolean);
    const meta = who.length
      ? who.map((n) => el('span', { class: 'pill ' + ownerPillClass(n, family) }, n))
      : a.calendar ? [el('span', { class: 'pill' }, a.calendar + (a.tentative ? ' · tentative' : ''))] : [];
    // A birthday-titled event spotlights under "birthday" (matching the
    // summary's gift heads-up), not the generic "event" bucket.
    const cat = /\bbirthday\b/i.test(a.title || '') ? 'birthday' : 'event';
    rows.push(el('div', { class: rowCls('tw-row', cat) }, [
      el('div', { class: 'tw-time' + (a.allDay ? ' allday' : '') }, a.allDay ? 'all day' : to12h(a.startTime)),
      el('div', {}, [
        el('div', { class: 'tw-title' }, a.title + (a.endDate && a.endDate > a.date && a.date !== date ? ' (cont.)' : '')),
        meta.length ? el('div', { class: 'tw-meta' }, meta) : null,
      ]),
    ]));
  }
  for (const c of tasks) {
    rows.push(el('div', { class: rowCls('tw-row', 'task') }, [
      el('div', { class: 'tw-time allday' }, 'task'),
      el('div', {}, [
        el('div', { class: 'tw-title' }, c.title),
        el('div', { class: 'tw-meta' }, [
          el('span', { class: 'pill pill-soon' }, 'due'),
          c.assignee ? el('span', { class: 'pill ' + ownerPillClass(c.assignee, family) }, c.assignee) : null,
        ]),
      ]),
    ]));
  }
  return rows;
}

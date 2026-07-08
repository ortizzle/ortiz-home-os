// meeting.js — the weekly family meeting, as one unit: pick Family (kids
// included, fun + togetherness) or Admin (Chris + Kat, household ops), keep
// a running agenda scoped to that type and this meeting cycle, and have
// Claudia create the agenda in one shot. No calendar summary here — Calendar
// already covers that; this stays focused on the agenda + the draft.
//
// Agenda items carry `type` (family/admin) and `cycleDate` (which meeting
// they belong to — YYYY-MM-DD). The visible list is always just THIS type +
// THIS cycle; once the meeting date passes, `nextMeetingDate()` advances and
// the list naturally starts empty for the new cycle. Anything left un-
// checked from the previous cycle isn't shown, but it IS fed to Claudia as
// follow-through context so it's not just quietly forgotten.

import { getAll, put, remove, getSettings, deviceName } from './store.js';
import { el, clear, toast, navigate, todayStr, addDays, parseDate, dateStr, fmtDay, shareText, preserveScroll } from './ui.js';
import { appointmentsFor } from './calendar.js';
import { errandWindow } from './suggest.js';
import { hasApiKey, draftMeeting, AIError } from './ai.js';
import { DEFAULT_HOUSEHOLD_NOTES } from './hmcontext.js';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const CHECK_SVG = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

// Meeting type — per device, remembers your last choice. Family = Wednesday-
// style, kids included; Admin = Chris + Kat, household ops.
const MEETING_TYPE_KEY = 'ohos.meetingType';
function getMeetingType() { return localStorage.getItem(MEETING_TYPE_KEY) === 'admin' ? 'admin' : 'family'; }
function setMeetingType(t) { localStorage.setItem(MEETING_TYPE_KEY, t === 'admin' ? 'admin' : 'family'); }

function to12h(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}
function wkShort(dateStr) {
  return parseDate(dateStr).toLocaleDateString(undefined, { weekday: 'short' });
}

// Split week-ahead appointments into one-offs (the interesting stuff) and
// recurring series that land on multiple days (shown once, with a day range).
function collapseAppts(appts) {
  const groups = new Map();
  for (const a of appts) {
    const key = a.seriesId || 'title:' + a.title;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }
  const oneoffs = [];
  const recurring = [];
  for (const list of groups.values()) {
    const sorted = list.slice().sort((a, b) => (a.date + (a.startTime || '') < b.date + (b.startTime || '') ? -1 : 1));
    const dates = [...new Set(sorted.map((a) => a.date))];
    if (dates.length >= 2) {
      recurring.push({ title: sorted[0].title, startTime: sorted[0].startTime, range: `${wkShort(dates[0])}–${wkShort(dates[dates.length - 1])}` });
    } else {
      oneoffs.push(sorted[0]);
    }
  }
  oneoffs.sort((a, b) => (a.date + (a.startTime || '') < b.date + (b.startTime || '') ? -1 : 1));
  return { oneoffs, recurring };
}

function familyMembers() {
  const raw = (getSettings().familyMembers || 'Chris, Kat, Sedona, River');
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

// Family = Wednesday/after dinner by default; Admin = Thursday/after 8pm,
// just Chris + Kat. Each type keeps its own day, time, and cycle.
function meetingDay(type) {
  const d = Number(getSettings()[type === 'admin' ? 'adminMeetingDay' : 'meetingDay']);
  const fallback = type === 'admin' ? 4 : 3;
  return Number.isInteger(d) && d >= 0 && d <= 6 ? d : fallback;
}

function meetingTime(type) {
  const s = getSettings();
  return type === 'admin' ? (s.adminMeetingTime || 'after 8pm') : (s.familyMeetingTime || 'after dinner');
}

function attendeesFor(type) {
  if (type === 'admin') {
    const raw = getSettings().adminAttendees || 'Chris, Kat';
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return familyMembers();
}

// The date of this week's meeting: today if it's meeting day, else the next
// one. Doubles as the "cycle" key for agenda items — the day after this date
// passes, a fresh nextMeetingDate() starts a new, empty cycle. Family and
// Admin meet on different days, so this is always computed per type.
function nextMeetingDate(type) {
  const today = parseDate(todayStr());
  const delta = (meetingDay(type) - today.getDay() + 7) % 7;
  return addDays(todayStr(), delta); // addDays returns a YYYY-MM-DD string
}

// Gather the next 7 days of household activity into a text summary for
// Claude to draft from. Not shown as its own panel (Calendar already covers
// that) — this is purely AI context now.
async function gatherWeekAhead() {
  const today = todayStr();
  const end = addDays(today, 7);
  const [appointments, chores, groceries] = await Promise.all([
    appointmentsFor(today, end),
    getAll('chores'),
    getAll('groceries'),
  ]);

  const appts = appointments
    .filter((a) => a.date >= today && a.date < end)
    .sort((a, b) => (a.date + (a.startTime || '') < b.date + (b.startTime || '') ? -1 : 1));
  const dueChores = chores
    .filter((c) => c.dueDate && c.dueDate >= today && c.dueDate < end && !c.done)
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));
  const openGroceries = groceries.filter((g) => !g.gotAt);
  const win = errandWindow(getSettings());

  const { oneoffs, recurring } = collapseAppts(appts);
  const lines = [];
  if (oneoffs.length) {
    lines.push('One-off events (of most interest):');
    for (const a of oneoffs) lines.push(`  - ${fmtDay(a.date)}${a.startTime ? ' ' + to12h(a.startTime) : ''}: ${a.title}${a.who ? ` (${a.who})` : ''}`);
  }
  if (recurring.length) {
    lines.push('Recurring this week (daily/repeating — mention once):');
    for (const r of recurring) lines.push(`  - ${r.title} (${r.range}${r.startTime ? ', ' + to12h(r.startTime) : ''})`);
  }
  if (dueChores.length) {
    lines.push('Tasks due:');
    for (const c of dueChores) lines.push(`  - ${fmtDay(c.dueDate)}: ${c.title}${c.assignee ? ` (${c.assignee})` : ''}`);
  }
  if (openGroceries.length) {
    lines.push(`Grocery list: ${openGroceries.length} open item${openGroceries.length === 1 ? '' : 's'}${win ? ` (errand day is ${win})` : ''}.`);
  }

  return { appts, dueChores, openGroceries, summary: lines.join('\n') };
}

function agendaRow(item, rerender) {
  return el('div', { class: 'task-row' + (item.reviewed ? ' done' : '') }, [
    el('button', {
      class: 'task-check',
      'aria-label': item.reviewed ? 'Mark not reviewed' : 'Mark reviewed',
      html: item.reviewed ? CHECK_SVG : '',
      onclick: async () => {
        await put('agenda', { ...item, reviewed: !item.reviewed, reviewedBy: !item.reviewed ? deviceName() : null });
        rerender();
      },
    }),
    el('div', { class: 'task-main' }, [
      el('span', { class: 'task-name' }, item.text),
      item.by ? el('span', { class: 'task-meta' }, [el('span', { class: 'pill' }, item.by)]) : null,
    ]),
    el('button', {
      class: 'link',
      style: 'padding: 4px 6px; font-size: 15px; line-height: 1',
      'aria-label': 'Remove item',
      onclick: async () => {
        await remove('agenda', item.id);
        rerender();
      },
    }, '×'),
  ]);
}

// The full family-meeting experience as embeddable nodes — hosted on the
// Claudia tab (embedded) and still reachable standalone at #/meeting.
export async function meetingSection(rerender, { embedded = true } = {}) {
  const nodes = [];
  const root = { append: (...n) => nodes.push(...n.filter(Boolean)) }; // collect instead of mount

  // Family and Admin meet on different days — each type gets its own cycle date.
  const meetingDateByType = { family: nextMeetingDate('family'), admin: nextMeetingDate('admin') };
  let type = getMeetingType();
  const meetingDate = meetingDateByType[type];
  const isToday = meetingDate === todayStr();

  // Lazy-migrate legacy agenda items (from before type/cycleDate existed)
  // onto their type's current cycle, once, so nothing old just vanishes. And
  // prune: reviewed items from past cycles are finished business, and
  // unreviewed ones older than ~5 weeks have aged out of follow-through —
  // without this the agenda store (and the follow-up prompt) grows forever.
  const rawAgenda = await getAll('agenda');
  const staleCutoff = addDays(todayStr(), -35);
  const agenda = [];
  for (const a of rawAgenda) {
    const aType = a.type || 'family';
    if (!a.cycleDate) {
      a.type = aType;
      a.cycleDate = meetingDateByType[aType];
      await put('agenda', a, { touch: false });
    }
    const pastCycle = a.cycleDate < meetingDateByType[aType];
    if ((pastCycle && a.reviewed) || a.cycleDate < staleCutoff) {
      await remove('agenda', a.id);
      continue;
    }
    agenda.push(a);
  }
  agenda.sort((a, b) => ((a.createdAt || '') < (b.createdAt || '') ? -1 : 1));
  const week = await gatherWeekAhead();

  const meta = `${isToday ? 'Today' : DAY_NAMES[meetingDay(type)]} · ${fmtDay(meetingDate)}, ${meetingTime(type)} — ${attendeesFor(type).join(', ')}`;
  const headEl = embedded
    ? el('div', { class: 'panel-head', style: 'margin-top: 20px' }, [el('h4', {}, 'Family meeting')])
    : el('div', { class: 'view-head' }, [el('h1', {}, 'Family Meeting')]);

  // ----- meeting type: Family (kids, fun) or Admin (Chris + Kat, household ops) -----
  const typeBtn = (t, label) =>
    el('button', {
      class: 'btn seg-btn' + (type === t ? ' active' : ''),
      onclick: () => { type = t; setMeetingType(t); rerender(); },
    }, label);

  // Agenda scoped to this type + this cycle only — a new cycle starts empty
  // the day after the meeting date passes.
  const cycleAgenda = agenda.filter((a) => a.cycleDate === meetingDate && (a.type || 'family') === type);
  // Un-checked items from the previous cycle, same type — not shown as rows,
  // but fed to Claudia so a dropped topic doesn't just disappear.
  const stillOpenItems = agenda.filter((a) => !a.reviewed && a.cycleDate && a.cycleDate < meetingDate && (a.type || 'family') === type);

  // ----- agenda input -----
  const input = el('input', { class: 'input', placeholder: 'Add an agenda item…' });
  async function add() {
    const text = input.value.trim();
    if (!text) return;
    await put('agenda', { text, reviewed: false, type, cycleDate: meetingDate });
    input.value = '';
    // Re-render replaces this input — refocus the new one for rapid entry.
    await rerender();
    document.querySelector('input[placeholder="Add an agenda item…"]')?.focus();
  }
  input.addEventListener('keydown', (e) => e.key === 'Enter' && add());

  // ----- Claudia: create the agenda — one tap fills the list above with her
  // full proposal (topics + icebreakers + activities for Family; a brisk
  // task list for Admin), merged in alongside anything you've already typed.
  // Nothing requires a second tap to "accept" — just delete what you don't
  // want from the list, then Share.
  const statusHost = el('div', {});
  const createLabel = () => `Create the ${type === 'admin' ? 'Admin' : 'Family'} agenda`;
  const createBtn = el('button', {
    class: 'btn btn-primary full',
    onclick: async () => {
      if (!hasApiKey()) {
        toast('Add a Claude API key in Settings first', 'warn');
        return navigate('#/settings');
      }
      const label = createLabel();
      createBtn.disabled = 'disabled';
      createBtn.textContent = 'Creating…';
      clear(statusHost).append(el('div', { class: 'loading' }, [el('div', { class: 'spinner' }), el('span', {}, 'Claudia is creating the agenda…')]));
      try {
        const plan = await getAll('plan');
        const openItems = [
          ...week.dueChores.map((c) => `- ${c.title} (due ${fmtDay(c.dueDate)})`),
          ...plan.filter((p) => !p.done).map((p) => `- ${p.title || p.text}`),
        ].join('\n');
        const currentAgenda = cycleAgenda.filter((a) => !a.reviewed).map((a) => `- ${a.text}`).join('\n');
        const stillOpen = stillOpenItems.map((a) => `- ${a.text}`).join('\n');
        const out = await draftMeeting({
          attendees: attendeesFor(type),
          notes: getSettings().householdNotes || DEFAULT_HOUSEHOLD_NOTES,
          meetingDate: fmtDay(meetingDate),
          when: meetingTime(type),
          weekAhead: week.summary,
          openItems,
          currentAgenda,
          stillOpen,
          type,
        });
        const added = await mergeDraftIntoAgenda(out, cycleAgenda, type, meetingDate);
        clear(statusHost);
        toast(added ? `Added ${added} item${added === 1 ? '' : 's'} from Claudia — remove anything you don’t want below` : 'Claudia didn’t have anything new to add', 'success');
        rerender();
      } catch (err) {
        clear(statusHost).append(el('p', { class: 'muted small' }, err instanceof AIError ? err.message : `Something went wrong: ${err.message}`));
        createBtn.disabled = null;
        createBtn.textContent = label;
      }
    },
  }, createLabel());

  // ----- share the final, curated agenda (whatever's left after you've
  // removed what you don't want) -----
  const shareBtn = el('button', {
    class: 'btn',
    onclick: () => shareText({
      title: `${type === 'admin' ? 'Admin' : 'Family'} meeting agenda`,
      text: agendaToText(cycleAgenda, { type, meetingDateLabel: fmtDay(meetingDate) }),
    }),
  }, '📤 Share agenda');

  // ----- assemble as one unit -----
  root.append(
    headEl,
    el('section', { class: 'panel' }, [
      el('p', { class: 'muted small', style: 'margin: 0 0 10px' }, meta),
      el('div', { class: 'seg' }, [typeBtn('family', 'Family'), typeBtn('admin', 'Admin')]),

      el('h5', { class: 'meeting-unit-heading' }, `Agenda (${cycleAgenda.filter((a) => !a.reviewed).length} open)`),
      el('div', { class: 'grocery-add' }, [input, el('button', { class: 'btn btn-primary', onclick: add }, 'Add')]),
      ...(cycleAgenda.length ? cycleAgenda.map((a) => agendaRow(a, rerender)) : [el('p', { class: 'muted small' }, 'No agenda items yet. Jot down what you want to talk about, or have Claudia create the agenda below.')]),
      cycleAgenda.length ? el('div', { style: 'margin-top: 10px' }, [shareBtn]) : null,

      el('h5', { class: 'meeting-unit-heading' }, 'Plan with Claudia'),
      el('p', { class: 'muted small' },
        hasApiKey()
          ? 'One tap fills the agenda above with her full proposal — topics, plus icebreakers and activities for Family (or a brisk task list for Admin) — merged in with anything you’ve already typed. Delete what you don’t want, then Share. Carries forward anything left open from last time.'
          : 'Optional: add a Claude API key in Settings to have Claudia create the agenda. Everything above works without it.'),
      createBtn,
      statusHost,
    ])
  );

  return nodes;
}

// Merge Claudia's proposal directly into the running agenda — topics,
// icebreakers, and activities all become real agenda rows immediately (no
// per-item "accept" step). Skips anything whose text already appears in the
// current cycle (case-insensitive), so re-running this doesn't duplicate.
// Returns how many new rows were actually added.
async function mergeDraftIntoAgenda(out, cycleAgenda, type, cycleDate) {
  const existing = new Set(cycleAgenda.map((a) => a.text.trim().toLowerCase()));
  const candidates = [
    ...(out.draftAgenda || []).map((s) => s.topic),
    ...(out.icebreakers || []).map((t) => `Icebreaker: ${t}`),
    ...(out.activities || []).map((t) => `Activity: ${t}`),
  ];
  let added = 0;
  for (const text of candidates) {
    const key = (text || '').trim().toLowerCase();
    if (!key || existing.has(key)) continue;
    existing.add(key);
    await put('agenda', { text, reviewed: false, type, cycleDate });
    added++;
  }
  return added;
}

// Standalone page for the legacy #/meeting route.
export async function renderMeeting(root) {
  const rerender = preserveScroll(() => renderMeeting(root));
  clear(root);
  root.append(...(await meetingSection(rerender, { embedded: false })));
}

// Plain-text version of the current (already-curated) agenda, for Copy /
// Share (paste into email, Notes, Google Docs, wherever).
function agendaToText(cycleAgenda, { type, meetingDateLabel } = {}) {
  const lines = [`${type === 'admin' ? 'Admin' : 'Family'} meeting${meetingDateLabel ? ` — ${meetingDateLabel}` : ''}`, ''];
  for (const a of cycleAgenda) lines.push(`- ${a.text}`);
  return lines.join('\n').trim();
}

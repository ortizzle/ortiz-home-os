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

// Which run-of-show section an agenda item belongs to. Manual adds and
// legacy items default to 'topic'.
const AGENDA_SECTIONS = [['open', 'Open'], ['topic', 'Topics'], ['decision', 'Decisions needed'], ['close', 'Close']];
function agendaSectionOf(a) {
  return AGENDA_SECTIONS.some(([k]) => k === a.section) ? a.section : 'topic';
}

function agendaRow(item, rerender) {
  const row = el('div', { class: 'task-row' + (item.reviewed ? ' done' : '') }, [
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
  // Decision capture: once an item is checked off, offer a one-line "what did
  // we decide?" note. Saved onto the item, recapped at the next meeting, and
  // fed to Claudia so settled decisions aren't re-raised.
  if (!item.reviewed) return row;
  let extra;
  if (item.decision) {
    extra = el('p', { class: 'muted small', style: 'margin: 0 0 8px 40px' }, `Decision: ${item.decision}`);
  } else {
    const input = el('input', { class: 'input', placeholder: 'What did we decide? (optional)', style: 'font-size: 13px' });
    const save = async () => {
      const text = input.value.trim();
      if (!text) return;
      await put('agenda', { ...item, decision: text, decidedBy: deviceName() });
      rerender();
    };
    input.addEventListener('keydown', (e) => e.key === 'Enter' && save());
    extra = el('div', { class: 'grocery-add', style: 'margin: 0 0 8px 40px' }, [input, el('button', { class: 'btn', onclick: save }, 'Save')]);
  }
  return el('div', {}, [row, extra]);
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
  // prune: reviewed items from past cycles are finished business — except
  // ones with a logged decision, which stick around ~2 weeks so they can be
  // recapped at the next meeting. Unreviewed items older than ~5 weeks have
  // aged out of follow-through — without this the agenda store (and the
  // follow-up prompt) grows forever.
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
    const keepForRecap = a.reviewed && a.decision && a.cycleDate >= addDays(meetingDateByType[aType], -14);
    // Icebreakers (Open) and activities (Close) are per-meeting fluff — never
    // "unfinished business." Drop them once their cycle passes instead of
    // carrying them forward, so a skipped meeting doesn't pile up a wall of
    // stale icebreakers. Only real topics/decisions carry over.
    const ephemeral = ['open', 'close'].includes(agendaSectionOf(a));
    if (
      (pastCycle && a.reviewed && !keepForRecap) ||
      (pastCycle && !a.reviewed && ephemeral) ||
      a.cycleDate < staleCutoff
    ) {
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
  // Un-checked items from the previous cycle, same type — shown as a visible
  // "carried over" group (pull into this week or drop) AND fed to Claudia so
  // a dropped topic doesn't just disappear, even if a meeting was skipped.
  const stillOpenItems = agenda.filter((a) => !a.reviewed && a.cycleDate && a.cycleDate < meetingDate && (a.type || 'family') === type);
  // Decisions logged at the previous meeting — recapped up top, and fed to
  // Claudia so settled questions aren't re-raised.
  const decidedLastTime = agenda.filter((a) => a.reviewed && a.decision && a.cycleDate && a.cycleDate < meetingDate && (a.type || 'family') === type);

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
        const decisions = decidedLastTime.map((a) => `- ${a.text}: ${a.decision}`).join('\n');
        const out = await draftMeeting({
          attendees: attendeesFor(type),
          notes: getSettings().householdNotes || DEFAULT_HOUSEHOLD_NOTES,
          meetingDate: fmtDay(meetingDate),
          when: meetingTime(type),
          weekAhead: week.summary,
          openItems,
          currentAgenda,
          stillOpen,
          decisions,
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

  // ----- decisions from last meeting, recapped up top -----
  const recapNodes = decidedLastTime.length ? [
    el('h5', { class: 'meeting-unit-heading' }, 'Decided last meeting'),
    ...decidedLastTime.map((a) => el('p', { class: 'muted small', style: 'margin: 0 0 4px' }, `${a.text} — ${a.decision}`)),
  ] : [];

  // ----- carried over from last cycle: topics/decisions left open last time.
  // Full-width rows with checkboxes; bulk "add to this week" / "drop" so a
  // backlog after a skipped meeting is a few taps, not one button per row. -----
  const carriedSelected = new Set();
  const addSelBtn = el('button', {
    class: 'btn seg-btn hm-add',
    onclick: async () => {
      for (const a of stillOpenItems) if (carriedSelected.has(a.id)) await put('agenda', { ...a, cycleDate: meetingDate });
      rerender();
    },
  }, '↩ Add to this week');
  const dropSelBtn = el('button', {
    class: 'btn',
    onclick: async () => {
      for (const a of stillOpenItems) if (carriedSelected.has(a.id)) await remove('agenda', a.id);
      rerender();
    },
  }, 'Drop');
  function refreshCarriedBulk() {
    const n = carriedSelected.size;
    addSelBtn.disabled = n ? null : 'disabled';
    dropSelBtn.disabled = n ? null : 'disabled';
    addSelBtn.textContent = n ? `↩ Add ${n} to this week` : '↩ Add to this week';
  }
  const carriedRow = (a) => {
    const cb = el('input', {
      type: 'checkbox', class: 'carry-check',
      onchange: () => { cb.checked ? carriedSelected.add(a.id) : carriedSelected.delete(a.id); refreshCarriedBulk(); },
    });
    return el('label', { class: 'carry-row' }, [cb, el('span', { class: 'carry-text' }, a.text)]);
  };
  const carriedNodes = stillOpenItems.length ? [
    el('h5', { class: 'meeting-unit-heading' }, `Carried over from last meeting (${stillOpenItems.length})`),
    el('p', { class: 'muted small', style: 'margin: 0 0 8px' }, 'Topics left open last time. Check the ones to bring into this week, then add them — or drop what’s no longer worth raising.'),
    ...stillOpenItems.map(carriedRow),
    el('div', { class: 'hm-actions', style: 'margin-top: 8px' }, [addSelBtn, dropSelBtn]),
  ] : [];
  refreshCarriedBulk();

  // ----- the agenda itself, as a run-of-show. Plain list while everything is
  // an untyped topic (manual adds); section headings appear once Claudia's
  // structured draft (or any sectioned item) is in the mix. -----
  const structured = cycleAgenda.some((a) => agendaSectionOf(a) !== 'topic');
  const agendaNodes = !cycleAgenda.length
    ? [el('p', { class: 'muted small' }, 'No agenda items yet. Jot down what you want to talk about, or have Claudia create the agenda below.')]
    : !structured
      ? cycleAgenda.map((a) => agendaRow(a, rerender))
      : AGENDA_SECTIONS.flatMap(([key, label]) => {
          const items = cycleAgenda.filter((a) => agendaSectionOf(a) === key);
          if (!items.length) return [];
          return [
            el('p', { class: 'muted small', style: 'margin: 10px 0 2px; font-weight: 600' }, label),
            ...items.map((a) => agendaRow(a, rerender)),
          ];
        });

  // ----- assemble as one unit -----
  root.append(
    headEl,
    el('section', { class: 'panel' }, [
      el('p', { class: 'muted small', style: 'margin: 0 0 10px' }, meta),
      el('div', { class: 'seg' }, [typeBtn('family', 'Family'), typeBtn('admin', 'Admin')]),

      ...recapNodes,
      ...carriedNodes,

      el('h5', { class: 'meeting-unit-heading' }, `Agenda (${cycleAgenda.filter((a) => !a.reviewed).length} open)`),
      el('div', { class: 'grocery-add' }, [input, el('button', { class: 'btn btn-primary', onclick: add }, 'Add')]),
      ...agendaNodes,
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
// per-item "accept" step), each tagged with its run-of-show section so the
// list renders as a structured meeting (Open → Topics → Decisions → Close).
// Skips anything whose text already appears in the current cycle
// (case-insensitive), so re-running this doesn't duplicate. Returns how many
// new rows were actually added.
async function mergeDraftIntoAgenda(out, cycleAgenda, type, cycleDate) {
  const existing = new Set(cycleAgenda.map((a) => a.text.trim().toLowerCase()));
  const candidates = [
    ...(out.icebreakers || []).map((t) => ({ text: t, section: 'open' })),
    ...(out.draftAgenda || []).map((s) => ({ text: s.topic, section: s.needsDecision ? 'decision' : 'topic' })),
    ...(out.activities || []).map((t) => ({ text: t, section: 'close' })),
  ];
  let added = 0;
  for (const { text, section } of candidates) {
    const key = (text || '').trim().toLowerCase();
    if (!key || existing.has(key)) continue;
    existing.add(key);
    await put('agenda', { text, reviewed: false, type, cycleDate, section });
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
// Share (paste into email, Notes, Google Docs, wherever). Mirrors the
// on-screen run-of-show: sectioned when the agenda is structured, flat when
// it's all manual topics. Logged decisions ride along under their items.
function agendaToText(cycleAgenda, { type, meetingDateLabel } = {}) {
  const lines = [`${type === 'admin' ? 'Admin' : 'Family'} meeting${meetingDateLabel ? ` — ${meetingDateLabel}` : ''}`, ''];
  const itemLines = (a) => {
    lines.push(`- ${a.text}`);
    if (a.decision) lines.push(`    Decision: ${a.decision}`);
  };
  const structured = cycleAgenda.some((a) => agendaSectionOf(a) !== 'topic');
  if (!structured) {
    for (const a of cycleAgenda) itemLines(a);
  } else {
    for (const [key, label] of AGENDA_SECTIONS) {
      const items = cycleAgenda.filter((a) => agendaSectionOf(a) === key);
      if (!items.length) continue;
      lines.push(`${label}:`);
      for (const a of items) itemLines(a);
      lines.push('');
    }
  }
  return lines.join('\n').trim();
}

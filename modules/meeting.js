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
import { el, clear, toast, navigate, todayStr, addDays, parseDate, dateStr, fmtDay, shareText, preserveScroll, openModal } from './ui.js';
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
// one. Doubles as the "cycle" key for agenda items. A fresh cycle starts when
// the meeting date passes — OR when the family taps "Meeting concluded",
// which records `concludedCycle` so this occurrence is skipped and next
// week's (empty) agenda begins immediately. Per type (Family/Admin differ).
function nextMeetingDate(type, concludedCycle) {
  const today = parseDate(todayStr());
  const delta = (meetingDay(type) - today.getDay() + 7) % 7;
  const d = addDays(todayStr(), delta); // addDays returns a YYYY-MM-DD string
  // Already wrapped this occurrence up? Jump to the next one.
  return concludedCycle && concludedCycle >= d ? addDays(d, 7) : d;
}

// Synced per-type cycle state (concluded marker), keyed by type in its store.
async function getConcludedMap() {
  const rows = await getAll('meetingState');
  const map = {};
  for (const r of rows) map[r.id] = r.concludedCycle || null;
  return map;
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

  // Family and Admin meet on different days — each type gets its own cycle
  // date, skipping any occurrence already concluded (synced marker).
  const concluded = await getConcludedMap();
  const meetingDateByType = { family: nextMeetingDate('family', concluded.family), admin: nextMeetingDate('admin', concluded.admin) };
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
      createBtn.textContent = 'Organizing…';
      clear(statusHost).append(el('div', { class: 'loading' }, [el('div', { class: 'spinner' }), el('span', {}, 'Claudia is structuring the agenda…')]));
      try {
        const plan = await getAll('plan');
        const openItems = [
          ...week.dueChores.map((c) => `- ${c.title} (due ${fmtDay(c.dueDate)})`),
          ...plan.filter((p) => !p.done).map((p) => `- ${p.title || p.text}`),
        ].join('\n');
        const currentAgenda = cycleAgenda.filter((a) => !a.reviewed).map((a) => `- ${a.text}`).join('\n');
        const stillOpen = stillOpenItems.map((a) => `- ${a.text}`).join('\n');
        // Decisions from past meetings AND this one — re-running the draft
        // after checking things off / logging decisions must actually change
        // her proposal, not re-propose settled ground (the old bug: only past
        // cycles were passed, so mid-cycle decisions were invisible).
        const decidedThisCycle = cycleAgenda.filter((a) => a.reviewed && a.decision);
        const decisions = [...decidedThisCycle, ...decidedLastTime].map((a) => `- ${a.text}: ${a.decision}`).join('\n');
        const covered = cycleAgenda.filter((a) => a.reviewed).map((a) => `- ${a.text}${a.decision ? ` (decided: ${a.decision})` : ''}`).join('\n');
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
          covered,
          type,
        });
        const { organized, added } = await applyStructuredAgenda(out, cycleAgenda, type, meetingDate);
        clear(statusHost);
        const parts = [];
        if (organized) parts.push(`organized ${organized} item${organized === 1 ? '' : 's'}`);
        if (added) parts.push(`added ${added}`);
        toast(parts.length ? `Claudia ${parts.join(' and ')} — grouped into a run-of-show below` : 'Claudia had nothing to change', 'success');
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

  // ----- conclude the meeting: closes this cycle now (next week's agenda
  // starts fresh), and decides what to do with anything left unchecked. Logged
  // decisions carry into next week's recap and into Claudia's weekly review. --
  async function finishConclude() {
    await put('meetingState', { id: type, concludedCycle: meetingDate });
    toast('Meeting concluded — next week’s agenda is ready', 'success');
    rerender();
  }
  function openConclude() {
    const openRows = cycleAgenda.filter((a) => !a.reviewed);
    if (!openRows.length) {
      const m = openModal('Conclude meeting?', [
        el('p', { class: 'muted small', style: 'margin-top: 0' }, 'Close this meeting and start next week’s agenda? Anything you decided carries into next week’s recap.'),
      ], [
        el('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
        el('button', { class: 'btn btn-primary', onclick: async () => { m.close(); await finishConclude(); } }, 'Conclude'),
      ]);
      return;
    }
    // One choice per unchecked item — carry forward (default), make a task, or drop.
    const choice = new Map(openRows.map((a) => [a.id, 'carry']));
    const rows = openRows.map((a) => {
      const seg = (val, label) => el('button', {
        class: 'btn seg-btn' + (choice.get(a.id) === val ? ' active' : ''),
        onclick: (e) => {
          choice.set(a.id, val);
          for (const b of e.currentTarget.parentElement.children) b.classList.remove('active');
          e.currentTarget.classList.add('active');
        },
      }, label);
      return el('div', { class: 'conclude-row' }, [
        el('span', { class: 'conclude-text' }, a.text),
        el('div', { class: 'seg' }, [seg('carry', 'Carry'), seg('task', 'Task'), seg('drop', 'Drop')]),
      ]);
    });
    const m = openModal('Conclude meeting', [
      el('p', { class: 'muted small', style: 'margin-top: 0' }, 'These weren’t checked off. Pick what happens to each, then conclude — this starts next week’s agenda.'),
      ...rows,
    ], [
      el('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          for (const a of openRows) {
            const c = choice.get(a.id);
            if (c === 'task') { await put('chores', { title: a.text, done: false, assignee: a.who || null }); await remove('agenda', a.id); }
            else if (c === 'drop') { await remove('agenda', a.id); }
            // 'carry' → leave as-is; becomes "Carried over" once the cycle advances
          }
          m.close();
          await finishConclude();
        },
      }, 'Conclude'),
    ]);
  }
  const concludeBtn = el('button', { class: 'btn', onclick: openConclude }, '✓ Meeting concluded');

  // ----- decisions from last meeting, recapped up top -----
  const recapNodes = decidedLastTime.length ? [
    el('h5', { class: 'meeting-unit-heading' }, 'Decided last meeting'),
    ...decidedLastTime.map((a) => el('p', { class: 'muted small', style: 'margin: 0 0 4px' }, `${a.text} — ${a.decision}`)),
  ] : [];

  // ----- carried over from last cycle: topics/decisions left open last time.
  // Full-width rows with checkboxes; bulk actions so a backlog after a skipped
  // meeting is a few taps, not one button per row. "Next week" = the next time
  // this meeting type happens (its upcoming cycle). "Move to Admin/Family"
  // reroutes a topic that belongs in the other meeting instead. -----
  const otherType = type === 'admin' ? 'family' : 'admin';
  const otherLabel = otherType === 'admin' ? 'Admin' : 'Family';
  const carriedSelected = new Set();
  const addSelBtn = el('button', {
    class: 'btn seg-btn hm-add',
    onclick: async () => {
      for (const a of stillOpenItems) if (carriedSelected.has(a.id)) await put('agenda', { ...a, cycleDate: meetingDate });
      rerender();
    },
  }, '↩ Add to next week');
  const moveSelBtn = el('button', {
    class: 'btn',
    onclick: async () => {
      // Reroute to the other meeting's upcoming cycle, so it shows up there.
      for (const a of stillOpenItems) if (carriedSelected.has(a.id)) await put('agenda', { ...a, type: otherType, cycleDate: meetingDateByType[otherType] });
      rerender();
    },
  }, `Move to ${otherLabel}`);
  const dropSelBtn = el('button', {
    class: 'btn',
    onclick: async () => {
      for (const a of stillOpenItems) if (carriedSelected.has(a.id)) await remove('agenda', a.id);
      rerender();
    },
  }, 'Drop');
  function refreshCarriedBulk() {
    const n = carriedSelected.size;
    for (const b of [addSelBtn, moveSelBtn, dropSelBtn]) b.disabled = n ? null : 'disabled';
    addSelBtn.textContent = n ? `↩ Add ${n} to next week` : '↩ Add to next week';
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
    el('p', { class: 'muted small', style: 'margin: 0 0 8px' }, `Topics left open last time. Check the ones to bring into next week, move to the ${otherLabel} meeting, or drop what’s no longer worth raising.`),
    ...stillOpenItems.map(carriedRow),
    el('div', { class: 'hm-actions', style: 'margin-top: 8px' }, [addSelBtn, moveSelBtn, dropSelBtn]),
  ] : [];
  refreshCarriedBulk();

  // ----- the agenda itself, as a run-of-show. Plain list while everything is
  // an untyped topic (manual adds); section headings appear once Claudia's
  // structured draft (or any sectioned item) is in the mix. Either way, honor
  // Claudia's `order` when present (hand-typed items fall back to creation
  // order). -----
  const orderedAgenda = cycleAgenda.slice().sort((a, b) =>
    (a.order ?? Infinity) - (b.order ?? Infinity) || ((a.createdAt || '') < (b.createdAt || '') ? -1 : 1));
  const structured = orderedAgenda.some((a) => agendaSectionOf(a) !== 'topic');
  const agendaNodes = !orderedAgenda.length
    ? [el('p', { class: 'muted small' }, 'No agenda items yet. Jot down what you want to talk about, or have Claudia create the agenda below.')]
    : !structured
      ? orderedAgenda.map((a) => agendaRow(a, rerender))
      : AGENDA_SECTIONS.flatMap(([key, label]) => {
          const items = orderedAgenda.filter((a) => agendaSectionOf(a) === key);
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
      cycleAgenda.length ? el('div', { class: 'hm-actions', style: 'margin-top: 10px' }, [shareBtn, concludeBtn]) : null,

      el('h5', { class: 'meeting-unit-heading' }, 'Plan with Claudia'),
      el('p', { class: 'muted small' },
        hasApiKey()
          ? 'One tap takes what you’ve jotted above and organizes it into a run-of-show — grouped and ordered (Open → Topics → Decisions → Close), with any important gaps filled and, for Family, icebreakers + a closing activity. Nothing you typed is dropped; delete what you don’t want, then Share.'
          : 'Optional: add a Claude API key in Settings to have Claudia organize the agenda. Everything above works without it.'),
      createBtn,
      statusHost,
    ])
  );

  return nodes;
}

// Apply Claudia's structured agenda: she returns ONE ordered list, where each
// entry is either an existing jotted item (matched by exact text) or a new one,
// tagged with a run-of-show section. We organize in place — existing rows keep
// their identity but get her section + order; new rows are added; and any
// jotted item she somehow didn't mention is kept (never silently dropped),
// appended after. `order` drives the within-section ordering in the render, so
// the meeting flows the way she structured it. Returns { organized, added }.
async function applyStructuredAgenda(out, cycleAgenda, type, cycleDate) {
  const openItems = cycleAgenda.filter((a) => !a.reviewed);
  const byText = new Map(openItems.map((a) => [a.text.trim().toLowerCase(), a]));
  const seen = new Set();
  let order = 0, organized = 0, added = 0;
  for (const entry of out.agenda || []) {
    const text = (entry.topic || '').trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    const section = AGENDA_SECTIONS.some(([k]) => k === entry.section) ? entry.section : 'topic';
    const existing = byText.get(key);
    if (existing) {
      await put('agenda', { ...existing, section, order });
      organized++;
    } else {
      await put('agenda', { text, reviewed: false, type, cycleDate, section, order });
      added++;
    }
    order++;
  }
  // Safety net: keep any jotted item she didn't place, appended at the end.
  for (const a of openItems) {
    if (!seen.has(a.text.trim().toLowerCase())) await put('agenda', { ...a, order: order++ });
  }
  return { organized, added };
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
  cycleAgenda = cycleAgenda.slice().sort((a, b) =>
    (a.order ?? Infinity) - (b.order ?? Infinity) || ((a.createdAt || '') < (b.createdAt || '') ? -1 : 1));
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

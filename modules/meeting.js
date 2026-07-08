// meeting.js — the weekly family meeting: pick Family (kids included, fun
// + togetherness) or Admin (Chris + Kat, household ops), keep a running
// agenda, and have Claude draft or review it. No calendar summary here —
// Calendar is the place for that; this stays focused on the agenda + draft.

import { getAll, put, remove, getSettings, deviceName } from './store.js';
import { el, clear, toast, navigate, todayStr, addDays, parseDate, dateStr, fmtDay, shareText } from './ui.js';
import { appointmentsFor } from './calendar.js';
import { errandWindow } from './suggest.js';
import { hasApiKey, reviewFamilyMeeting, draftMeeting, AIError } from './ai.js';
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
// Series are keyed by seriesId when present (mirrored Google events carry it),
// falling back to title for anything else.
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

function meetingDay() {
  const d = Number(getSettings().meetingDay);
  return Number.isInteger(d) && d >= 0 && d <= 6 ? d : 3; // default Wednesday
}

// The date of this week's meeting: today if it's meeting day, else the next one.
function nextMeetingDate() {
  const today = parseDate(todayStr());
  const delta = (meetingDay() - today.getDay() + 7) % 7;
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
  const agenda = (await getAll('agenda')).sort((a, b) => ((a.createdAt || '') < (b.createdAt || '') ? -1 : 1));
  const week = await gatherWeekAhead();
  const meetingDate = nextMeetingDate();
  const isToday = meetingDate === todayStr();

  const meta = `${isToday ? 'Today' : DAY_NAMES[meetingDay()]} · ${fmtDay(meetingDate)} — ${familyMembers().join(', ')}`;
  if (embedded) {
    root.append(
      el('div', { class: 'panel-head', style: 'margin-top: 20px' }, [el('h4', {}, 'Family meeting')]),
      el('p', { class: 'muted small', style: 'margin: -4px 0 8px' }, meta)
    );
  } else {
    root.append(el('div', { class: 'view-head' }, [el('h1', {}, 'Family Meeting'), el('p', { class: 'muted' }, meta)]));
  }

  // ----- meeting type: Family (kids, fun) or Admin (Chris + Kat, household ops) -----
  let type = getMeetingType();
  const typeBtn = (t, label) =>
    el('button', {
      class: 'btn seg-btn' + (type === t ? ' active' : ''),
      onclick: (e) => {
        type = t;
        setMeetingType(t);
        e.currentTarget.parentElement.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b === e.currentTarget));
        draftBtn.textContent = draftLabel();
      },
    }, label);
  root.append(el('div', { class: 'seg' }, [typeBtn('family', 'Family'), typeBtn('admin', 'Admin')]));

  // ----- agenda -----
  const input = el('input', { class: 'input', placeholder: 'Add an agenda item…' });
  async function add() {
    const text = input.value.trim();
    if (!text) return;
    await put('agenda', { text, reviewed: false });
    input.value = '';
    input.focus();
    rerender();
  }
  input.addEventListener('keydown', (e) => e.key === 'Enter' && add());
  root.append(
    el('div', { class: 'panel-head' }, [el('h4', {}, `Agenda (${agenda.filter((a) => !a.reviewed).length} open)`)]),
    el('section', { class: 'panel' }, [
      el('div', { class: 'grocery-add' }, [input, el('button', { class: 'btn btn-primary', onclick: add }, 'Add')]),
      ...(agenda.length ? agenda.map((a) => agendaRow(a, rerender)) : [el('p', { class: 'muted small' }, 'No agenda items yet. Jot down what you want to talk about this week.')]),
    ])
  );

  // ----- Claude: draft the meeting / review the agenda -----
  root.append(el('div', { class: 'panel-head' }, [el('h4', {}, 'Plan with Claudia')]));
  const resultHost = el('div', {});
  const draftLabel = () => `Draft the ${type === 'admin' ? 'Admin' : 'Family'} meeting`;

  const draftBtn = el('button', {
    class: 'btn btn-primary full',
    onclick: async () => {
      if (!hasApiKey()) {
        toast('Add a Claude API key in Settings first', 'warn');
        return navigate('#/settings');
      }
      const label = draftLabel();
      draftBtn.disabled = 'disabled';
      draftBtn.textContent = 'Drafting…';
      clear(resultHost).append(el('div', { class: 'loading' }, [el('div', { class: 'spinner' }), el('span', {}, 'Claudia is drafting your meeting…')]));
      try {
        const plan = await getAll('plan');
        const openItems = [
          ...week.dueChores.map((c) => `- ${c.title} (due ${fmtDay(c.dueDate)})`),
          ...plan.filter((p) => !p.done).map((p) => `- ${p.title || p.text}`),
        ].join('\n');
        const currentAgenda = agenda.filter((a) => !a.reviewed).map((a) => `- ${a.text}`).join('\n');
        const out = await draftMeeting({
          family: familyMembers(),
          notes: getSettings().householdNotes || DEFAULT_HOUSEHOLD_NOTES,
          meetingDate: fmtDay(meetingDate),
          weekAhead: week.summary,
          openItems,
          currentAgenda,
          type,
        });
        renderDraft(resultHost, out, rerender, { type, meetingDate: fmtDay(meetingDate) });
      } catch (err) {
        clear(resultHost).append(el('p', { class: 'muted small' }, err instanceof AIError ? err.message : `Something went wrong: ${err.message}`));
      } finally {
        draftBtn.disabled = null;
        draftBtn.textContent = label;
      }
    },
  }, draftLabel());

  const reviewBtn = el('button', {
    class: 'btn full',
    onclick: async () => {
      if (!hasApiKey()) {
        toast('Add a Claude API key in Settings first', 'warn');
        return navigate('#/settings');
      }
      reviewBtn.disabled = 'disabled';
      reviewBtn.textContent = 'Reviewing…';
      clear(resultHost).append(el('div', { class: 'loading' }, [el('div', { class: 'spinner' }), el('span', {}, 'Claudia is reviewing the agenda…')]));
      try {
        const out = await reviewFamilyMeeting({
          family: familyMembers(),
          meetingDate: fmtDay(meetingDate),
          agenda,
          weekAhead: week.summary,
        });
        renderReview(resultHost, out);
      } catch (err) {
        clear(resultHost).append(el('p', { class: 'muted small' }, err instanceof AIError ? err.message : `Something went wrong: ${err.message}`));
      } finally {
        reviewBtn.disabled = null;
        reviewBtn.textContent = 'Review our meeting';
      }
    },
  }, 'Review our meeting');

  root.append(
    el('section', { class: 'panel' }, [
      el('p', { class: 'muted small', style: 'margin-top:0' },
        hasApiKey()
          ? 'Draft the meeting: Claudia proposes an agenda from this week, plus icebreakers and activities to add with one tap. Review: she checks what you’ve covered and what’s still open.'
          : 'Optional: add a Claude API key in Settings to have Claudia draft and review the meeting. Everything above works without it.'),
      draftBtn,
      hasApiKey() ? reviewBtn : null,
      resultHost,
    ])
  );

  return nodes;
}

// Standalone page for the legacy #/meeting route.
export async function renderMeeting(root) {
  clear(root);
  root.append(...(await meetingSection(() => renderMeeting(root), { embedded: false })));
}

// A "+ Agenda" chip that drops a drafted line onto the running agenda. It
// flips to "Added ✓" in place rather than re-rendering, so the whole draft
// stays on screen while you cherry-pick from it.
function agendaAddBtn(text) {
  const btn = el('button', {
    class: 'btn seg-btn hm-add',
    onclick: async () => {
      await put('agenda', { text, reviewed: false });
      btn.disabled = 'disabled';
      btn.textContent = 'Added ✓';
      toast('Added to agenda', 'success');
    },
  }, '+ Agenda');
  return el('div', { class: 'hm-actions' }, [btn]);
}

// Plain-text version of the draft, for Copy / Share (paste into email,
// Notes, Google Docs, wherever) — no in-app formatting needed elsewhere.
function draftToText(out, { type, meetingDate } = {}) {
  const lines = [`${type === 'admin' ? 'Admin' : 'Family'} meeting${meetingDate ? ` — ${meetingDate}` : ''}`, ''];
  if (out.draftAgenda?.length) {
    lines.push('Agenda:');
    for (const s of out.draftAgenda) lines.push(`- ${s.topic}${s.why ? ` (${s.why})` : ''}`);
    lines.push('');
  }
  if (out.icebreakers?.length) {
    lines.push('Icebreakers:');
    for (const t of out.icebreakers) lines.push(`- ${t}`);
    lines.push('');
  }
  if (out.activities?.length) {
    lines.push('Activities:');
    for (const t of out.activities) lines.push(`- ${t}`);
  }
  return lines.join('\n').trim();
}

function renderDraft(host, out, rerender, ctx = {}) {
  clear(host);
  const section = (title, node) => el('div', { class: 'meeting-section' }, [el('h5', {}, title), node]);

  if (out.draftAgenda?.length) {
    host.append(section('Proposed agenda', el('div', {}, out.draftAgenda.map((s) =>
      el('div', { class: 'idea' }, [
        el('div', { class: 'idea-title' }, s.topic),
        s.why ? el('p', { class: 'idea-detail' }, s.why) : null,
        agendaAddBtn(s.topic),
      ])
    ))));
  }
  if (out.icebreakers?.length) {
    host.append(section('Icebreakers', el('div', {}, out.icebreakers.map((t) =>
      el('div', { class: 'idea' }, [
        el('div', { class: 'idea-title' }, t),
        agendaAddBtn(`Icebreaker: ${t}`),
      ])
    ))));
  }
  if (out.activities?.length) {
    host.append(section('Activities', el('div', {}, out.activities.map((t) =>
      el('div', { class: 'idea' }, [
        el('div', { class: 'idea-title' }, t),
        agendaAddBtn(`Activity: ${t}`),
      ])
    ))));
  }
  if (!host.children.length) {
    host.append(el('p', { class: 'muted small' }, 'Claudia didn’t have a draft to add — try jotting a few week notes above.'));
    return;
  }
  // Share/copy the whole draft as plain text — paste into email, Notes,
  // Google Docs, wherever. Native share sheet first, clipboard fallback.
  host.append(
    el('button', {
      class: 'btn full', style: 'margin-top: 10px',
      onclick: () => shareText({ title: 'Family meeting draft', text: draftToText(out, ctx) }),
    }, '📤 Share / copy draft')
  );
}

function bulletList(items) {
  return el('ul', { class: 'meeting-list' }, (items || []).map((t) => el('li', {}, t)));
}

function renderReview(host, out) {
  clear(host);
  const section = (title, node) => el('div', { class: 'meeting-section' }, [el('h5', {}, title), node]);

  if (out.alreadyCovered?.length) {
    host.append(section('Already reviewed', bulletList(out.alreadyCovered)));
  }
  if (out.needsReview?.length) {
    host.append(section('Still needs discussion', bulletList(out.needsReview)));
  }
  if (out.suggestedAgenda?.length) {
    host.append(section('Suggested agenda', el('ol', { class: 'meeting-list' }, out.suggestedAgenda.map((s) =>
      el('li', {}, [el('strong', {}, s.topic), s.why ? el('span', { class: 'muted' }, ` — ${s.why}`) : null])
    ))));
  }
  if (out.tips?.length) {
    host.append(section('Tips', bulletList(out.tips)));
  }
  if (!host.children.length) {
    host.append(el('p', { class: 'muted small' }, 'Claudia didn’t have much to add — your agenda looks in good shape.'));
  }
}

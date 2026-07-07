// meeting.js — the weekly family meeting. A space to review the week ahead,
// keep a running agenda, and (optionally) have Claude review the agenda and
// suggest how to structure a good meeting. The Ortizes meet Wednesdays.

import { getAll, put, remove, getSettings, deviceName } from './store.js';
import { el, clear, toast, navigate, todayStr, addDays, parseDate, dateStr, fmtDay } from './ui.js';
import { getMaintenance, nextDue } from './maintenance.js';
import { appointmentsFor } from './calendar.js';
import { errandWindow } from './suggest.js';
import { hasApiKey, reviewFamilyMeeting, draftMeeting, AIError } from './ai.js';
import { DEFAULT_HOUSEHOLD_NOTES } from './hmcontext.js';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const CHECK_SVG = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

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

// Gather the next 7 days of household activity, as records + a text summary
// for the AI. Kept deterministic so the "week ahead" panel works with no key.
async function gatherWeekAhead() {
  const today = todayStr();
  const end = addDays(today, 7);
  const [appointments, chores, maintenance, groceries] = await Promise.all([
    appointmentsFor(today, end),
    getAll('chores'),
    getMaintenance(),
    getAll('groceries'),
  ]);

  const appts = appointments
    .filter((a) => a.date >= today && a.date < end)
    .sort((a, b) => (a.date + (a.startTime || '') < b.date + (b.startTime || '') ? -1 : 1));
  const dueChores = chores
    .filter((c) => c.dueDate && c.dueDate >= today && c.dueDate < end && !c.done)
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));
  const dueMaint = maintenance.filter((m) => nextDue(m) >= today && nextDue(m) < end);
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
    lines.push('Chores due:');
    for (const c of dueChores) lines.push(`  - ${fmtDay(c.dueDate)}: ${c.title}${c.assignee ? ` (${c.assignee})` : ''}`);
  }
  if (dueMaint.length) {
    lines.push('Home upkeep due:');
    for (const m of dueMaint) lines.push(`  - ${fmtDay(nextDue(m))}: ${m.title}`);
  }
  if (openGroceries.length) {
    lines.push(`Grocery list: ${openGroceries.length} open item${openGroceries.length === 1 ? '' : 's'}${win ? ` (errand day is ${win})` : ''}.`);
  }

  return { appts, dueChores, dueMaint, openGroceries, summary: lines.join('\n') };
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

  // ----- the week ahead (deterministic; no API key needed) -----
  // One-offs are what the family actually needs to talk about; daily-recurring
  // events (camps, lessons) collapse to a single line so they don't drown them.
  const { oneoffs, recurring } = collapseAppts(week.appts);
  root.append(el('div', { class: 'panel-head' }, [el('h4', {}, 'The week ahead')]));
  const weekItems = [];
  for (const a of oneoffs) weekItems.push(el('div', { class: 'event-row' }, [el('span', { class: 'event-time' }, `${fmtDay(a.date)}${a.startTime ? ' · ' + to12h(a.startTime) : ''}`), el('span', { class: 'event-title' }, [a.title, a.who ? el('span', { class: 'event-who' }, `· ${a.who}`) : null])]));
  for (const c of week.dueChores) weekItems.push(el('div', { class: 'event-row' }, [el('span', { class: 'event-time' }, fmtDay(c.dueDate)), el('span', { class: 'event-title' }, `○ ${c.title}`)]));
  for (const m of week.dueMaint) weekItems.push(el('div', { class: 'event-row' }, [el('span', { class: 'event-time' }, fmtDay(nextDue(m))), el('span', { class: 'event-title' }, `⟳ ${m.title}`)]));
  if (week.openGroceries.length) weekItems.push(el('div', { class: 'event-row' }, [el('span', { class: 'event-time' }, 'Groceries'), el('span', { class: 'event-title' }, `${week.openGroceries.length} open item${week.openGroceries.length === 1 ? '' : 's'}`)]));
  root.append(el('section', { class: 'panel' }, weekItems.length ? weekItems : [el('p', { class: 'muted small' }, 'Nothing scheduled in the next 7 days.')]));

  // Recurring (daily/repeating) — collapsed to one line each, muted below.
  if (recurring.length) {
    root.append(
      el('div', { class: 'panel-head' }, [el('h4', {}, 'Also recurring this week')]),
      el('section', { class: 'panel' }, recurring.map((r) =>
        el('div', { class: 'event-row' }, [el('span', { class: 'event-time' }, r.range), el('span', { class: 'event-title muted' }, `${r.title}${r.startTime ? ` · ${to12h(r.startTime)}` : ''}`)])
      ))
    );
  }

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

  const draftBtn = el('button', {
    class: 'btn btn-primary full',
    onclick: async () => {
      if (!hasApiKey()) {
        toast('Add a Claude API key in Settings first', 'warn');
        return navigate('#/settings');
      }
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
        });
        renderDraft(resultHost, out, rerender);
      } catch (err) {
        clear(resultHost).append(el('p', { class: 'muted small' }, err instanceof AIError ? err.message : `Something went wrong: ${err.message}`));
      } finally {
        draftBtn.disabled = null;
        draftBtn.textContent = 'Draft the meeting';
      }
    },
  }, 'Draft the meeting');

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

function renderDraft(host, out, _rerender) {
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
  }
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

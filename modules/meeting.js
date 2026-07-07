// meeting.js — the weekly family meeting. A space to review the week ahead,
// keep a running agenda, and (optionally) have Claude review the agenda and
// suggest how to structure a good meeting. The Ortizes meet Wednesdays.

import { getAll, put, remove, getSettings, deviceName } from './store.js';
import { el, clear, toast, navigate, todayStr, addDays, parseDate, dateStr, fmtDay } from './ui.js';
import { getMaintenance, nextDue } from './maintenance.js';
import { errandWindow } from './suggest.js';
import { hasApiKey, reviewFamilyMeeting, AIError } from './ai.js';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const CHECK_SVG = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

function familyMembers() {
  const raw = (getSettings().familyMembers || 'Chris, Cat, Sedona, River');
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
    getAll('appointments'),
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

  const lines = [];
  if (appts.length) {
    lines.push('Appointments:');
    for (const a of appts) lines.push(`  - ${fmtDay(a.date)}${a.startTime ? ' ' + a.startTime : ''}: ${a.title}${a.who ? ` (${a.who})` : ''}`);
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

export async function renderMeeting(root) {
  clear(root);
  const rerender = () => renderMeeting(root);
  const agenda = (await getAll('agenda')).sort((a, b) => ((a.createdAt || '') < (b.createdAt || '') ? -1 : 1));
  const week = await gatherWeekAhead();
  const meetingDate = nextMeetingDate();
  const isToday = meetingDate === todayStr();

  root.append(
    el('div', { class: 'view-head' }, [
      el('h1', {}, 'Family Meeting'),
      el('p', { class: 'muted' }, `${isToday ? 'Today' : DAY_NAMES[meetingDay()]} · ${fmtDay(meetingDate)} — ${familyMembers().join(', ')}`),
    ])
  );

  // ----- the week ahead (deterministic; no API key needed) -----
  root.append(el('div', { class: 'panel-head' }, [el('h4', {}, 'The week ahead')]));
  const weekItems = [];
  for (const a of week.appts) weekItems.push(el('div', { class: 'event-row' }, [el('span', { class: 'event-time' }, fmtDay(a.date)), el('span', { class: 'event-title' }, [a.title, a.who ? el('span', { class: 'event-who' }, `· ${a.who}`) : null])]));
  for (const c of week.dueChores) weekItems.push(el('div', { class: 'event-row' }, [el('span', { class: 'event-time' }, fmtDay(c.dueDate)), el('span', { class: 'event-title' }, `○ ${c.title}`)]));
  for (const m of week.dueMaint) weekItems.push(el('div', { class: 'event-row' }, [el('span', { class: 'event-time' }, fmtDay(nextDue(m))), el('span', { class: 'event-title' }, `⟳ ${m.title}`)]));
  if (week.openGroceries.length) weekItems.push(el('div', { class: 'event-row' }, [el('span', { class: 'event-time' }, 'Groceries'), el('span', { class: 'event-title' }, `${week.openGroceries.length} open item${week.openGroceries.length === 1 ? '' : 's'}`)]));
  root.append(el('section', { class: 'panel' }, weekItems.length ? weekItems : [el('p', { class: 'muted small' }, 'Nothing scheduled in the next 7 days.')]));

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

  // ----- Claude review -----
  root.append(el('div', { class: 'panel-head' }, [el('h4', {}, 'Claude review')]));
  const resultHost = el('div', {});
  const reviewBtn = el('button', {
    class: 'btn btn-primary full',
    onclick: async () => {
      if (!hasApiKey()) {
        toast('Add a Claude API key in Settings first', 'warn');
        return navigate('#/settings');
      }
      reviewBtn.disabled = 'disabled';
      reviewBtn.textContent = 'Reviewing…';
      clear(resultHost).append(el('div', { class: 'loading' }, [el('div', { class: 'spinner' }), el('span', {}, 'Claude is reviewing the agenda…')]));
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
          ? 'Claude reads the agenda and the week ahead, then says what you’ve covered, what still needs discussion, and how to structure the meeting.'
          : 'Optional: add a Claude API key in Settings to have Claude help structure the meeting. Everything above works without it.'),
      reviewBtn,
      resultHost,
    ])
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
    host.append(el('p', { class: 'muted small' }, 'Claude didn’t have much to add — your agenda looks in good shape.'));
  }
}

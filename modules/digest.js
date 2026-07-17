// digest.js — "The stretch ahead": the computed, no-AI read of everything
// between now and the next family meeting, shown at the top of the Claudia
// tab. Facts before opinions: this section is assembled entirely from data
// the app already has (calendar overlay, tasks, memory, follow-through log),
// so it renders instantly, costs nothing, and can never hallucinate —
// Claudia's AI review below it only interprets this same picture.

import { getAll, getSettings } from './store.js';
import { el, disclosure, navigate, fmtDay, todayStr, addDays } from './ui.js';
import { appointmentsFor } from './calendar.js';
import { householdKnowledge, upcomingBirthdays, calendarBirthdays, mergeBirthdays, getSuggestionMemory } from './hmcontext.js';
import { planningHorizon, collapseAppts } from './meeting.js';

const CAP = 6; // per-list cap — the digest is a scan, not an archive
const BDAY_DAYS = 35; // birthday lookahead (~5 weeks), wider than the horizon

function sub(text) {
  return el('h5', { class: 'meeting-unit-heading' }, text);
}
function line(children, cls = 'muted small') {
  return el('p', { class: cls, style: 'margin: 2px 0' }, children);
}
function capped(arr, render, cap = CAP) {
  const nodes = arr.slice(0, cap).map(render);
  if (arr.length > cap) nodes.push(line(`… and ${arr.length - cap} more`));
  return nodes;
}
function to12(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

// `open` controls whether the disclosure starts expanded — the Claudia tab
// collapses it while a review is mid-decision so the queue stays front and
// center, and re-opens it once the queue is done (or before a fresh run).
export async function digestSection({ open = true } = {}) {
  const today = todayStr();
  const settings = getSettings();
  const { throughDate } = await planningHorizon(today);
  // Fetch through the LATER of the meeting horizon and the birthday lookahead
  // (ISO strings, so max is lexical) — "Coming up" still cuts at throughDate,
  // but the birthday scan below gets the full ~5 weeks of calendar to read.
  const fetchEnd = [addDays(throughDate, 1), addDays(today, BDAY_DAYS + 1)].sort().at(-1);
  const [appts, chores, agenda, memory, knowledge] = await Promise.all([
    appointmentsFor(today, fetchEnd).catch(() => []),
    getAll('chores'),
    getAll('agenda'),
    getSuggestionMemory(),
    householdKnowledge(getSettings(), { today }),
  ]);

  const nodes = [];

  // ----- coming up: calendar through the horizon, recurring collapsed -----
  const inWindow = appts.filter((a) => a.date <= throughDate && (a.endDate || a.date) >= today);
  const { oneoffs, recurring } = collapseAppts(inWindow);
  nodes.push(sub('Coming up'));
  if (!oneoffs.length && !recurring.length) {
    nodes.push(line('Nothing on the calendar for this stretch.'));
  } else {
    nodes.push(...capped(oneoffs, (a) =>
      line(a.endDate && a.endDate > a.date
        ? [el('strong', {}, `${fmtDay(a.date)}–${fmtDay(a.endDate)}`), ` · ${a.title} (trip)`]
        : [el('strong', {}, fmtDay(a.date)), `${a.startTime ? ' ' + to12(a.startTime) : ''} · ${a.title}${a.who ? ` (${a.who})` : ''}`])
    ));
    for (const r of recurring) nodes.push(line(`↻ ${r.title} (${r.range}${r.startTime ? ', ' + to12(r.startTime) : ''})`));
  }

  // ----- birthdays: Claudia's memory + birthday-titled calendar events,
  // ~5 weeks out, deduped so a birthday she knows isn't listed twice -----
  const bdays = mergeBirthdays(
    upcomingBirthdays(knowledge, today, BDAY_DAYS),
    calendarBirthdays(appts, today, BDAY_DAYS)
  );
  if (bdays.length) {
    nodes.push(sub('Birthdays'));
    for (const b of bdays) {
      nodes.push(line([`🎂 `, el('strong', {}, b.name), ` — ${fmtDay(b.date)} (${b.daysAway === 0 ? 'today!' : b.daysAway === 1 ? 'tomorrow' : `in ${b.daysAway} days`})`]));
    }
  }

  // ----- tasks, your responsibilities first -----
  const me = (settings.deviceName || '').trim().toLowerCase();
  const openTasks = chores.filter((c) => !c.done);
  const isMine = (c) => me && (c.assignee || '').trim().toLowerCase() === me;
  const mine = openTasks.filter(isMine);
  const unassigned = openTasks.filter((c) => !c.assignee);
  const others = openTasks.filter((c) => c.assignee && !isMine(c));
  const overdue = (list) => list.filter((c) => c.dueDate && c.dueDate < today).length;
  nodes.push(sub(me ? `Tasks — yours first (${settings.deviceName})` : 'Tasks'));
  if (!openTasks.length) {
    nodes.push(line('No open tasks.'));
  } else {
    if (mine.length) {
      nodes.push(...capped(mine, (c) =>
        line([c.dueDate && c.dueDate < today ? '⚠️ ' : '• ', c.title, c.dueDate ? el('span', { class: 'muted' }, ` — due ${fmtDay(c.dueDate)}`) : null])
      ));
    } else if (me) {
      nodes.push(line('Nothing assigned to you. 🎉'));
    }
    if (unassigned.length) {
      nodes.push(line([el('strong', {}, `Unassigned (${unassigned.length}`), overdue(unassigned) ? el('strong', {}, `, ${overdue(unassigned)} overdue)`) : el('strong', {}, ')'), ' — these need an owner: ', unassigned.slice(0, 3).map((c) => c.title).join(' · '), unassigned.length > 3 ? ' …' : '']));
    }
    // Everyone else: counts only — their lists are theirs to work.
    const byOwner = {};
    for (const c of others) (byOwner[c.assignee.trim()] ||= []).push(c);
    for (const [name, list] of Object.entries(byOwner)) {
      nodes.push(line(`${name} — ${list.length} open${overdue(list) ? ` (${overdue(list)} overdue)` : ''}`));
    }
  }

  // ----- recalled from the last month: decisions, answers, loose ends -----
  const cutoff = addDays(today, -35);
  const decisions = agenda.filter((a) => a.reviewed && a.decision && a.cycleDate && a.cycleDate >= cutoff);
  const answers = memory.resolved.filter((r) => (r.resolvedAt || '') >= cutoff);
  const looseEnds = memory.added.filter((a) => !a.done && (a.addedAt || '') >= cutoff);
  if (decisions.length || answers.length || looseEnds.length) {
    nodes.push(sub('Recalled from the last month'));
    nodes.push(...capped(decisions, (a) => line([`✓ Decided: ${a.text} — `, el('strong', {}, a.decision)]), 4));
    nodes.push(...capped(answers, (r) => line(`💬 ${r.question} → ${r.answer || 'resolved'}`), 4));
    nodes.push(...capped(looseEnds, (a) => line(`◌ Still open: ${a.title} (added ${fmtDay(a.addedAt)})`), 4));
  }

  nodes.push(el('div', { class: 'hm-actions', style: 'margin-top: 10px' }, [
    el('button', { class: 'link', style: 'padding: 0', onclick: () => navigate('#/calendar') }, 'Calendar →'),
    el('button', { class: 'link', style: 'padding: 0', onclick: () => navigate('#/tasks') }, 'All tasks →'),
  ]));

  return disclosure(
    `The stretch ahead — through ${fmtDay(throughDate)}`,
    el('section', { class: 'panel' }, nodes),
    { open }
  );
}

// send-summary.mjs — the Wednesday-morning meeting summary, emailed to Chris.
// Runs after he's had Claudia draft this week's Family agenda in the app (that
// draft syncs to the Gist). If the agenda is there, it emails the run-of-show
// plus the week ahead and Claudia's latest weekly-review read. If it isn't
// drafted yet, it sends a short nudge to go build it. Recipient: SUMMARY_TO
// (defaults to the family Gmail).
import {
  readSnapshot, live, today, addDays, fmtDay, familyMeetingDate,
  plain, esc, sendMail, page, h, row, chip, ownerChip, quote, note,
} from './home-os.mjs';

const SECTIONS = [
  ['open', 'Open'],
  ['topic', 'Topics'],
  ['decision', 'Decisions needed'],
  ['close', 'Close'],
];
const sectionOf = (a) => (SECTIONS.some(([k]) => k === a.section) ? a.section : 'topic');
const to12h = (t) => {
  if (!t) return '';
  const [hh, mm] = t.split(':').map(Number);
  return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh >= 12 ? 'PM' : 'AM'}`;
};

const { data } = await readSnapshot();

// Recipients: SUMMARY_TO (comma-separated) takes full control if set;
// otherwise default to Chris + Kat, so both get the meeting agenda. Kat's
// address is the same KAT_EMAIL secret the daily task email uses.
const recipients = (
  process.env.SUMMARY_TO
    ? process.env.SUMMARY_TO.split(',')
    : [process.env.GMAIL_USER || 'chris.ortiz@gmail.com', process.env.KAT_EMAIL]
).map((s) => (s || '').trim()).filter(Boolean);
const to = [...new Set(recipients)].join(', ');

const start = today();
const meetingDate = familyMeetingDate(data);
const meetingLabel = fmtDay(meetingDate);

// This cycle's Family agenda (Claudia's drafted run-of-show), tombstone-clean.
const agenda = live(data, 'agenda')
  .filter((a) => (a.type || 'family') === 'family' && a.cycleDate === meetingDate)
  .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || ((a.createdAt || '') < (b.createdAt || '') ? -1 : 1));

// ----- no agenda yet → nudge (per the chosen behavior) -----
if (!agenda.length) {
  const subject = `Family meeting ${meetingLabel} — no agenda drafted yet`;
  const body =
    `No agenda for this week's Family meeting (${meetingLabel}) is in the app yet. ` +
    `Open Home OS, jot what you want to cover, and tap “Create the Family agenda” so ` +
    `Claudia can build the run-of-show — then it'll be here next time.`;
  await sendMail({
    to,
    subject,
    text: `${body}\n\nOpen Home OS: https://ortizzle.github.io/ortiz-home-os/`,
    html: page({ title: 'No agenda drafted yet', subtitle: `Family meeting · ${meetingLabel}`, body: note(body) }),
  });
  console.log('nudge sent — no agenda for this cycle.');
  process.exit(0);
}

// ----- the run-of-show -----
const structured = agenda.some((a) => sectionOf(a) !== 'topic');
const agendaText = [];
const agendaHtml = [];
const agendaItemRow = (a, last) =>
  row(esc(plain(a.text)), { sub: a.decision ? `Decided: ${esc(plain(a.decision))}` : '', last });
if (!structured) {
  agendaHtml.push(h('Agenda'));
  agenda.forEach((a, i) => {
    agendaText.push(`- ${plain(a.text)}${a.decision ? `\n    Decision: ${plain(a.decision)}` : ''}`);
    agendaHtml.push(agendaItemRow(a, i === agenda.length - 1));
  });
} else {
  for (const [key, label] of SECTIONS) {
    const items = agenda.filter((a) => sectionOf(a) === key);
    if (!items.length) continue;
    agendaText.push(`${label}:`);
    agendaHtml.push(h(label));
    items.forEach((a, i) => {
      agendaText.push(`  - ${plain(a.text)}${a.decision ? `\n      Decision: ${plain(a.decision)}` : ''}`);
      agendaHtml.push(agendaItemRow(a, i === items.length - 1));
    });
    agendaText.push('');
  }
}

// ----- decisions logged at the LAST meeting (recap) -----
// Only the single most recent past cycle — not a multi-week sweep — so the
// recap always reads as "what we decided last time," never a decision from a
// few meetings ago lingering around.
const pastDecisions = live(data, 'agenda')
  .filter((a) => (a.type || 'family') === 'family' && a.decision && a.cycleDate && a.cycleDate < meetingDate);
const lastCycle = pastDecisions.reduce((m, a) => (a.cycleDate > m ? a.cycleDate : m), '');
const decided = pastDecisions.filter((a) => a.cycleDate === lastCycle);

// ----- the week ahead (next 7 days): appointments + tasks due -----
const end = addDays(start, 7);
const appts = live(data, 'appointments')
  .filter((a) => a.date && a.date >= start && a.date < end)
  .sort((a, b) => (a.date + (a.startTime || '') < b.date + (b.startTime || '') ? -1 : 1));
const dueTasks = live(data, 'chores')
  .filter((c) => !c.done && c.dueDate && c.dueDate >= start && c.dueDate < end)
  .sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));

// ----- Claudia's latest weekly-review overview (bonus context) -----
// Only if it's fresh (run within the last ~week). The review record is a
// single "current" row that persists until the next run, so without this
// guard a review nobody's refreshed in weeks would keep getting quoted.
const review = live(data, 'reviews').find((r) => r && r.data);
const reviewFresh = review && review.reviewedAt && review.reviewedAt >= addDays(start, -8);
const overview = reviewFresh && review.data.overview ? plain(review.data.overview) : '';

// ----- assemble -----
const textParts = [
  `Family meeting — ${meetingLabel}`,
  '',
  'AGENDA',
  agendaText.join('\n').trim(),
];
if (decided.length) {
  textParts.push('', 'DECIDED LAST MEETING', ...decided.map((a) => `- ${plain(a.text)}: ${plain(a.decision)}`));
}
if (appts.length || dueTasks.length) {
  textParts.push('', 'THE WEEK AHEAD');
  for (const a of appts) textParts.push(`- ${fmtDay(a.date)}${a.startTime ? ' ' + a.startTime : ''}: ${a.title}${a.who ? ` (${a.who})` : ''}`);
  for (const c of dueTasks) textParts.push(`- ${fmtDay(c.dueDate)} · task: ${c.title}${c.assignee ? ` (${c.assignee})` : ''}`);
}
if (overview) textParts.push('', "CLAUDIA'S WEEKLY READ", overview);
textParts.push('', 'Open Home OS: https://ortizzle.github.io/ortiz-home-os/');

const htmlParts = [...agendaHtml];
if (decided.length) {
  htmlParts.push(h('Decided last meeting'));
  decided.forEach((a, i) =>
    htmlParts.push(row(esc(plain(a.text)), { sub: esc(plain(a.decision)), last: i === decided.length - 1 })));
}
if (appts.length || dueTasks.length) {
  htmlParts.push(h('The week ahead'));
  const wk = [];
  for (const a of appts) {
    wk.push({
      title: `${esc(a.title)}${a.who ? ' ' + ownerChip(a.who) : ''}`,
      sub: `${esc(fmtDay(a.date))}${a.startTime ? ' · ' + esc(to12h(a.startTime)) : ''}`,
    });
  }
  for (const c of dueTasks) {
    wk.push({
      title: `${esc(c.title)} ${chip('task', 'soon')}${c.assignee ? ' ' + ownerChip(c.assignee) : ''}`,
      sub: `Due ${esc(fmtDay(c.dueDate))}`,
    });
  }
  wk.forEach((r, i) => htmlParts.push(row(r.title, { sub: r.sub, last: i === wk.length - 1 })));
}
if (overview) {
  htmlParts.push(h("Claudia's weekly read"));
  htmlParts.push(quote(overview));
}

await sendMail({
  to,
  subject: `Family meeting summary — ${meetingLabel}`,
  text: textParts.join('\n'),
  html: page({ title: 'Family meeting summary', subtitle: `Meeting on ${meetingLabel}`, body: htmlParts.join('') }),
});

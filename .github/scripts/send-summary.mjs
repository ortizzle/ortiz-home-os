// send-summary.mjs — the Wednesday-morning meeting summary, emailed to Chris.
// Runs after he's had Claudia draft this week's Family agenda in the app (that
// draft syncs to the Gist). If the agenda is there, it emails the run-of-show
// plus the week ahead and Claudia's latest weekly-review read. If it isn't
// drafted yet, it sends a short nudge to go build it. Recipient: SUMMARY_TO
// (defaults to the family Gmail).
import {
  readSnapshot, live, today, addDays, fmtDay, familyMeetingDate,
  plain, esc, sendMail, page,
} from './home-os.mjs';

const SECTIONS = [
  ['open', 'Open'],
  ['topic', 'Topics'],
  ['decision', 'Decisions needed'],
  ['close', 'Close'],
];
const sectionOf = (a) => (SECTIONS.some(([k]) => k === a.section) ? a.section : 'topic');

const { data } = await readSnapshot();
const to = process.env.SUMMARY_TO || process.env.GMAIL_USER || 'chris.ortiz@gmail.com';

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
    html: page('No agenda drafted yet', `<p style="margin:0;">${esc(body)}</p>`),
  });
  console.log('nudge sent — no agenda for this cycle.');
  process.exit(0);
}

// ----- the run-of-show -----
const structured = agenda.some((a) => sectionOf(a) !== 'topic');
const agendaText = [];
const agendaHtml = [];
if (!structured) {
  for (const a of agenda) {
    agendaText.push(`- ${plain(a.text)}${a.decision ? `\n    Decision: ${plain(a.decision)}` : ''}`);
    agendaHtml.push(`<li style="margin:4px 0;">${esc(plain(a.text))}${a.decision ? `<div style="color:#6b7280;font-size:13px;">Decided: ${esc(plain(a.decision))}</div>` : ''}</li>`);
  }
} else {
  for (const [key, label] of SECTIONS) {
    const items = agenda.filter((a) => sectionOf(a) === key);
    if (!items.length) continue;
    agendaText.push(`${label}:`);
    agendaHtml.push(`<div style="font-weight:600;margin:12px 0 4px;color:#4b5563;">${label}</div><ul style="margin:0;padding-left:20px;">`);
    for (const a of items) {
      agendaText.push(`  - ${plain(a.text)}${a.decision ? `\n      Decision: ${plain(a.decision)}` : ''}`);
      agendaHtml.push(`<li style="margin:4px 0;">${esc(plain(a.text))}${a.decision ? `<div style="color:#6b7280;font-size:13px;">Decided: ${esc(plain(a.decision))}</div>` : ''}</li>`);
    }
    agendaHtml.push('</ul>');
    agendaText.push('');
  }
}

// ----- decisions logged at recent past meetings (recap) -----
const decided = live(data, 'agenda')
  .filter((a) => (a.type || 'family') === 'family' && a.decision && a.cycleDate && a.cycleDate < meetingDate && a.cycleDate >= addDays(meetingDate, -21))
  .sort((a, b) => (a.cycleDate < b.cycleDate ? 1 : -1));

// ----- the week ahead (next 7 days): appointments + tasks due -----
const end = addDays(start, 7);
const appts = live(data, 'appointments')
  .filter((a) => a.date && a.date >= start && a.date < end)
  .sort((a, b) => (a.date + (a.startTime || '') < b.date + (b.startTime || '') ? -1 : 1));
const dueTasks = live(data, 'chores')
  .filter((c) => !c.done && c.dueDate && c.dueDate >= start && c.dueDate < end)
  .sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));

// ----- Claudia's latest weekly-review overview (bonus context, if present) --
const review = live(data, 'reviews').find((r) => r && r.data);
const overview = review && review.data && review.data.overview ? plain(review.data.overview) : '';

// ----- assemble -----
const textParts = [
  `Family meeting — ${meetingLabel}`,
  '',
  'AGENDA',
  agendaText.join('\n').trim(),
];
if (decided.length) {
  textParts.push('', 'DECIDED RECENTLY', ...decided.map((a) => `- ${plain(a.text)}: ${plain(a.decision)}`));
}
if (appts.length || dueTasks.length) {
  textParts.push('', 'THE WEEK AHEAD');
  for (const a of appts) textParts.push(`- ${fmtDay(a.date)}${a.startTime ? ' ' + a.startTime : ''}: ${a.title}${a.who ? ` (${a.who})` : ''}`);
  for (const c of dueTasks) textParts.push(`- ${fmtDay(c.dueDate)} · task: ${c.title}${c.assignee ? ` (${c.assignee})` : ''}`);
}
if (overview) textParts.push('', "CLAUDIA'S WEEKLY READ", overview);
textParts.push('', 'Open Home OS: https://ortizzle.github.io/ortiz-home-os/');

const htmlParts = [`<div style="color:#6b7280;font-size:13px;margin:0 0 14px;">${esc(meetingLabel)}</div>`];
htmlParts.push('<div style="font-weight:700;margin:0 0 6px;">Agenda</div>');
htmlParts.push(structured ? agendaHtml.join('') : `<ul style="margin:0;padding-left:20px;">${agendaHtml.join('')}</ul>`);
if (decided.length) {
  htmlParts.push('<div style="font-weight:700;margin:20px 0 6px;">Decided recently</div><ul style="margin:0;padding-left:20px;">');
  for (const a of decided) htmlParts.push(`<li style="margin:4px 0;">${esc(plain(a.text))} — <span style="color:#6b7280;">${esc(plain(a.decision))}</span></li>`);
  htmlParts.push('</ul>');
}
if (appts.length || dueTasks.length) {
  htmlParts.push('<div style="font-weight:700;margin:20px 0 6px;">The week ahead</div><ul style="margin:0;padding-left:20px;">');
  for (const a of appts) htmlParts.push(`<li style="margin:4px 0;"><strong>${esc(fmtDay(a.date))}${a.startTime ? ' ' + esc(a.startTime) : ''}</strong> — ${esc(a.title)}${a.who ? ` <span style="color:#6b7280;">(${esc(a.who)})</span>` : ''}</li>`);
  for (const c of dueTasks) htmlParts.push(`<li style="margin:4px 0;"><strong>${esc(fmtDay(c.dueDate))}</strong> · task — ${esc(c.title)}${c.assignee ? ` <span style="color:#6b7280;">(${esc(c.assignee)})</span>` : ''}</li>`);
  htmlParts.push('</ul>');
}
if (overview) {
  htmlParts.push(`<div style="font-weight:700;margin:20px 0 6px;">Claudia's weekly read</div><p style="margin:0;color:#374151;">${esc(overview)}</p>`);
}

await sendMail({
  to,
  subject: `Family meeting summary — ${meetingLabel}`,
  text: textParts.join('\n'),
  html: page('Family meeting summary', htmlParts.join('')),
});

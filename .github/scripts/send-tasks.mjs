// send-tasks.mjs — the daily open-task list, emailed to Kat. Reads the chores
// store from the household Gist (tombstone-clean), groups by who it's on, and
// sorts by due date with overdue and due-today called out. Recipient:
// KAT_EMAIL. Sends every day, including an "all clear" line on empty days so
// the absence of tasks is a signal, not silence.
import {
  readSnapshot, live, today, fmtDay, esc, sendMail, page, isDryRun,
  h, row, chip, ownerHeading, note,
} from './home-os.mjs';

const { data } = await readSnapshot();
// A real send needs a recipient; a preview run can proceed without one so it's
// testable before the secret is set (the log just shows the placeholder).
const to = process.env.KAT_EMAIL || (isDryRun() ? '(KAT_EMAIL not set — preview)' : null);
if (!to) {
  throw new Error('Missing repo secret KAT_EMAIL — add Kat\'s address under GitHub → repo Settings → Secrets and variables → Actions.');
}

const start = today();
const open = live(data, 'chores').filter((c) => !c.done);

// Sort: dated first (soonest up top), undated after; overdue floats highest.
open.sort((a, b) => {
  const ad = a.dueDate || '9999-99-99';
  const bd = b.dueDate || '9999-99-99';
  return ad < bd ? -1 : ad > bd ? 1 : (a.createdAt || '') < (b.createdAt || '') ? -1 : 1;
});

// Group by assignee (unassigned last).
const groups = new Map();
for (const c of open) {
  const who = (c.assignee || '').trim() || 'Unassigned';
  if (!groups.has(who)) groups.set(who, []);
  groups.get(who).push(c);
}
const orderedGroups = [...groups.entries()].sort((a, b) => {
  if (a[0] === 'Unassigned') return 1;
  if (b[0] === 'Unassigned') return -1;
  return a[0] < b[0] ? -1 : 1;
});

const dateLabel = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Phoenix', weekday: 'long', month: 'long', day: 'numeric',
}).format(new Date());

// How a task's due date reads — plain-text label + which status chip to show.
function dueBits(c) {
  if (!c.dueDate) return { text: '' };
  if (c.dueDate < start) return { text: `overdue · ${fmtDay(c.dueDate)}`, kind: 'overdue', chip: `Overdue · ${fmtDay(c.dueDate)}` };
  if (c.dueDate === start) return { text: 'due today', kind: 'today', chip: 'Due today' };
  return { text: `due ${fmtDay(c.dueDate)}`, kind: 'soon', chip: `Due ${fmtDay(c.dueDate)}` };
}

// ----- empty state -----
if (!open.length) {
  const line = 'No open tasks right now — nothing outstanding on the household list. Enjoy the day!';
  await sendMail({
    to,
    subject: `Task list — ${dateLabel} · all clear`,
    text: `${line}\n\nOpen Home OS: https://ortizzle.github.io/ortiz-home-os/`,
    html: page({ title: 'All clear', subtitle: dateLabel, body: note(line) }),
  });
  process.exit(0);
}

// ----- text + html -----
const textLines = [`Open tasks — ${dateLabel}`, ''];
const htmlParts = [];

for (const [who, list] of orderedGroups) {
  textLines.push(`${who} (${list.length}):`);
  htmlParts.push(ownerHeading(who, list.length));
  list.forEach((c, i) => {
    const d = dueBits(c);
    textLines.push(`  - ${c.title}${d.text ? ` [${d.text}]` : ''}`);
    const title = `${esc(c.title)}${d.kind ? ' ' + chip(d.chip, d.kind) : ''}`;
    htmlParts.push(row(title, { last: i === list.length - 1 }));
  });
  textLines.push('');
}
textLines.push('Open Home OS: https://ortizzle.github.io/ortiz-home-os/');

await sendMail({
  to,
  subject: `Task list — ${dateLabel} · ${open.length} open`,
  text: textLines.join('\n'),
  html: page({ title: 'Household tasks', subtitle: `${dateLabel} · ${open.length} open`, body: htmlParts.join('') }),
});

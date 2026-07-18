// send-tasks.mjs — the daily open-task list, emailed to Kat. Reads the chores
// store from the household Gist (tombstone-clean), groups by who it's on, and
// sorts by due date with overdue and due-today called out. Recipient:
// KAT_EMAIL. Sends every day, including an "all clear" line on empty days so
// the absence of tasks is a signal, not silence.
import {
  readSnapshot, live, today, fmtDay, esc, sendMail, page, isDryRun,
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

// When/how a task's due date reads.
function dueBits(c) {
  if (!c.dueDate) return { text: '', tag: '', color: '#9aa3b2' };
  if (c.dueDate < start) return { text: `overdue · ${fmtDay(c.dueDate)}`, tag: 'overdue', color: '#c2410c' };
  if (c.dueDate === start) return { text: 'due today', tag: 'today', color: '#b45309' };
  return { text: `due ${fmtDay(c.dueDate)}`, tag: '', color: '#6b7280' };
}

// ----- empty state -----
if (!open.length) {
  const line = 'No open tasks right now — nothing outstanding on the household list. Enjoy the day!';
  await sendMail({
    to,
    subject: `Task list — ${dateLabel} · all clear`,
    text: `${line}\n\nOpen Home OS: https://ortizzle.github.io/ortiz-home-os/`,
    html: page('All clear', `<p style="margin:0;">${esc(line)}</p>`),
  });
  process.exit(0);
}

// ----- text + html -----
const textLines = [`Open tasks — ${dateLabel}`, ''];
const htmlParts = [`<div style="color:#6b7280;font-size:13px;margin:0 0 14px;">${esc(dateLabel)} · ${open.length} open</div>`];

for (const [who, list] of orderedGroups) {
  textLines.push(`${who} (${list.length}):`);
  htmlParts.push(`<div style="font-weight:700;margin:16px 0 6px;">${esc(who)} <span style="color:#9aa3b2;font-weight:400;font-size:13px;">(${list.length})</span></div><ul style="margin:0;padding-left:20px;">`);
  for (const c of list) {
    const d = dueBits(c);
    textLines.push(`  - ${c.title}${d.text ? ` [${d.text}]` : ''}`);
    htmlParts.push(
      `<li style="margin:5px 0;">${esc(c.title)}` +
      (d.text ? ` <span style="color:${d.color};font-size:13px;font-weight:600;">${esc(d.text)}</span>` : '') +
      `</li>`
    );
  }
  htmlParts.push('</ul>');
  textLines.push('');
}
textLines.push('Open Home OS: https://ortizzle.github.io/ortiz-home-os/');

await sendMail({
  to,
  subject: `Task list — ${dateLabel} · ${open.length} open`,
  text: textLines.join('\n'),
  html: page('Household tasks', htmlParts.join('')),
});

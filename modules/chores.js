// chores.js — one-off household tasks: due date, assignee. Same interaction
// grammar as Focus OS tasks.

import { getAll, put, remove, now, deviceName, getSettings } from './store.js';
import { el, clear, toast, openModal, todayStr, fmtDue, preserveScroll, disclosure } from './ui.js';
import { parseImport } from './grocery.js';

const CHECK_SVG = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

function familyMembers() {
  const raw = getSettings().familyMembers || 'Chris, Kat, Sedona, River';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export async function getOpenChores() {
  const chores = await getAll('chores');
  return chores.filter((c) => !c.done).sort(byDue);
}

function byDue(a, b) {
  return (a.dueDate || '9999') < (b.dueDate || '9999') ? -1 : 1;
}

export async function toggleChore(chore) {
  const done = !chore.done;
  return put('chores', { ...chore, done, doneAt: done ? now() : null, doneBy: done ? deviceName() : null });
}

// One chore row: check circle, title + meta pills (due, assignee).
export function choreRow(chore, { onchange, showDue = true } = {}) {
  const meta = [];
  if (showDue && chore.dueDate) {
    const overdue = !chore.done && chore.dueDate < todayStr();
    meta.push(el('span', { class: 'pill' + (overdue ? ' pill-overdue' : '') }, fmtDue(chore.dueDate)));
  }
  if (chore.assignee) meta.push(el('span', { class: 'pill pill-accent' }, chore.assignee));
  if (chore.done && chore.doneBy) meta.push(el('span', { class: 'pill pill-done' }, `done · ${chore.doneBy}`));

  return el('div', { class: 'task-row' + (chore.done ? ' done' : '') }, [
    el('button', {
      class: 'task-check',
      'aria-label': chore.done ? 'Mark not done' : 'Mark done',
      html: chore.done ? CHECK_SVG : '',
      onclick: async () => {
        await toggleChore(chore);
        onchange?.();
      },
    }),
    el('div', { class: 'task-main', onclick: () => editChoreModal(chore, onchange) }, [
      el('span', { class: 'task-name' }, chore.title),
      meta.length ? el('span', { class: 'task-meta' }, meta) : null,
    ]),
  ]);
}

// Create/edit bottom sheet. Pass no chore (or an id-less prefill) to create.
export async function editChoreModal(chore, onchange) {
  const isNew = !chore || !chore.id;
  const c = chore || {};

  const title = el('input', { class: 'input', placeholder: 'What needs doing?', value: c.title || '' });
  const due = el('input', { class: 'input', type: 'date', value: c.dueDate || '' });
  const familyOpts = familyMembers();
  const assignee = el('select', { class: 'input' }, [
    el('option', { value: '' }, 'Anyone'),
    ...familyOpts.map((name) => el('option', { value: name, selected: c.assignee === name ? 'selected' : null }, name)),
    // an old/custom assignee not in the current family list — keep it selectable so editing doesn't silently clear it
    c.assignee && !familyOpts.includes(c.assignee) ? el('option', { value: c.assignee, selected: 'selected' }, c.assignee) : null,
  ]);

  const actions = [
    !isNew &&
      el('button', {
        class: 'btn btn-danger',
        onclick: async () => {
          await remove('chores', c.id);
          toast('Task deleted');
          m.close();
          onchange?.();
        },
      }, 'Delete'),
    el('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
    el('button', {
      class: 'btn btn-primary',
      onclick: async () => {
        const name = title.value.trim();
        if (!name) return toast('Give the task a title', 'warn');
        await put('chores', {
          ...c,
          title: name,
          dueDate: due.value || null,
          assignee: assignee.value || null,
          done: c.done || false,
        });
        m.close();
        onchange?.();
      },
    }, isNew ? 'Add task' : 'Save'),
  ];

  const m = openModal(isNew ? 'New task' : 'Edit task', [
    el('label', { class: 'field-label' }, 'Title'),
    title,
    el('div', { class: 'field-row' }, [
      el('div', {}, [el('label', { class: 'field-label' }, 'Due date'), due]),
      el('div', {}, [el('label', { class: 'field-label' }, 'Assignee'), assignee]),
    ]),
  ], actions);
  title.focus();
}

export async function renderChores(root) {
  clear(root);
  const chores = await getAll('chores');
  const rerender = preserveScroll(() => renderChores(root));

  const today = todayStr();
  const open = chores.filter((c) => !c.done).sort(byDue);
  const groups = [
    ['Overdue', open.filter((c) => c.dueDate && c.dueDate < today)],
    ['Today', open.filter((c) => c.dueDate === today)],
    ['Upcoming', open.filter((c) => c.dueDate && c.dueDate > today)],
    ['Someday', open.filter((c) => !c.dueDate)],
  ];
  const done = chores
    .filter((c) => c.done)
    .sort((a, b) => ((b.doneAt || '') < (a.doneAt || '') ? -1 : 1));

  root.append(
    el('div', { class: 'view-head-row' }, [
      el('h1', {}, 'Tasks'),
      el('button', { class: 'btn btn-primary', onclick: () => editChoreModal(null, rerender) }, '+ New task'),
    ])
  );

  if (!chores.length) {
    root.append(
      el('div', { class: 'empty compact' }, [
        el('p', {}, 'No tasks yet.'),
        el('p', { class: 'muted' }, 'One-off household tasks live here. For recurring reminders (filters, gutters…), add them straight to Calendar.'),
      ])
    );
  }

  for (const [label, list] of groups) {
    if (!list.length) continue;
    root.append(
      el('h4', { class: 'group-heading' }, label),
      el('section', { class: 'panel' }, list.map((c) => choreRow(c, { onchange: rerender })))
    );
  }

  if (done.length) {
    root.append(disclosure(`Done (${done.length})`, el('section', { class: 'panel' }, done.slice(0, 20).map((c) => choreRow(c, { onchange: rerender })))));
  }

  // ----- Keep paste-import (Kat's list bridge) — collapsed: occasional use -----
  const importArea = el('textarea', { class: 'input', rows: 4, placeholder: 'Paste a to-do list from Google Keep — one item per line.\nBullets and checkboxes are fine.' });
  root.append(disclosure('Import from Keep', el('section', { class: 'panel import-box' }, [
    importArea,
    el('button', {
      class: 'btn',
      onclick: async () => {
        const names = parseImport(importArea.value);
        if (!names.length) return toast('Nothing to import', 'warn');
        for (const name of names) await put('chores', { title: name, done: false });
        toast(`Imported ${names.length} task${names.length === 1 ? '' : 's'}`, 'success');
        rerender();
      },
    }, 'Import as tasks'),
    el('p', { class: 'muted small' }, 'Keep has no API for personal accounts, so this paste box is the bridge. Copy a Keep note, paste here, and each line becomes a task.'),
  ])));
}

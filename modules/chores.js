// chores.js — one-off household tasks: due date, assignee. Same interaction
// grammar as Focus OS tasks.

import { getAll, put, remove, now, deviceName, getSettings } from './store.js';
import { el, clear, toast, openModal, todayStr, fmtDue, preserveScroll, disclosure } from './ui.js';
import { parseImport } from './grocery.js';
import { claudifyItem, hasApiKey, AIError } from './ai.js';
import { gatherContext, DEFAULT_HOUSEHOLD_NOTES } from './hmcontext.js';

const CHECK_SVG = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const TIMER_SVG = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12.5" r="8.5"/><path d="M12 8v4.5l3 2"/><path d="M9.5 2.5h5"/></svg>';

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
  if (chore.focusSeconds) meta.push(el('span', { class: 'pill' }, `⏱ ${fmtFocusPill(chore.focusSeconds)}`));
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
    !chore.done && el('button', {
      class: 'link task-focus-btn',
      html: TIMER_SVG,
      'aria-label': 'Focus on this task — timer + notes',
      onclick: () => openFocusModal(chore, onchange),
    }),
  ]);
}

const FOCUS_PRESETS = [15, 25, 45];
const FOCUS_DEFAULT_MIN = 25; // the timer always opens here; Custom is per-session
const FOCUS_MAX_MIN = 180;

function fmtClock(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Compact form for the row pill (fmtLoggedTime's sentence form is for the modal).
function fmtFocusPill(totalSec) {
  const m = Math.round(totalSec / 60);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  return `${(m / 60).toFixed(1)}h`;
}

function fmtLoggedTime(totalSec) {
  if (!totalSec) return null;
  const m = Math.round(totalSec / 60);
  if (m < 1) return 'under a minute logged on this task';
  if (m < 60) return `${m}m logged on this task`;
  return `${(m / 60).toFixed(1)}h logged on this task`;
}

// A short two-tone beep via Web Audio — no asset needed, and audio contexts
// created off an earlier user gesture (the Start tap) can still play later.
let audioCtx;
function playChime() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t0 = audioCtx.currentTime;
    [880, 1320].forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = freq;
      osc.connect(gain).connect(audioCtx.destination);
      const start = t0 + i * 0.16;
      gain.gain.setValueAtTime(0.001, start);
      gain.gain.exponentialRampToValueAtTime(0.2, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.3);
      osc.start(start);
      osc.stop(start + 0.32);
    });
  } catch {
    // Web Audio unsupported/blocked — the toast + visual state still land.
  }
}

// Focus timer + notes for one task — a lightweight in-app replacement for a
// separate focus-timer app. Countdown (not a stopwatch) with a remembered
// preset length; notes autosave; time actually spent accumulates onto the
// task (chore.focusSeconds) so it survives across sessions and however the
// sheet gets closed (Done, scrim tap, or letting it run and walking away).
function openFocusModal(chore, onchange) {
  let presetMin = FOCUS_DEFAULT_MIN;
  let remainingSec = presetMin * 60;
  let running = false;
  let endAt = null;
  let tickTimer = null;
  let runStartRemaining = null; // remainingSec at the moment this run segment began
  let sessionElapsedSec = 0;    // real seconds actually spent running, this modal open

  const display = el('div', { class: 'focus-timer-display' }, fmtClock(remainingSec));
  const loggedLine = el('p', { class: 'muted small', style: 'text-align:center; margin: 4px 0 0' }, fmtLoggedTime(chore.focusSeconds) || 'no time logged yet');

  // Length picker: three presets plus a Custom button that reveals a minutes
  // input. Changing length is disabled while running (stop first).
  function applyLength(min) {
    presetMin = min;
    remainingSec = presetMin * 60;
    display.textContent = fmtClock(remainingSec);
  }
  function refreshActive({ custom } = {}) {
    const isCustom = custom ?? !FOCUS_PRESETS.includes(presetMin);
    presetBtns.forEach((b, i) => b.classList.toggle('active', !isCustom && FOCUS_PRESETS[i] === presetMin));
    customBtn.classList.toggle('active', isCustom);
  }
  const presetBtns = FOCUS_PRESETS.map((min) =>
    el('button', {
      class: 'btn seg-btn',
      onclick: () => { if (running) return; applyLength(min); refreshActive(); customRow.style.display = 'none'; },
    }, `${min}m`)
  );
  const customBtn = el('button', {
    class: 'btn seg-btn',
    onclick: () => { if (running) return; customRow.style.display = ''; refreshActive({ custom: true }); customInput.focus(); },
  }, 'Custom');
  const presetRow = el('div', { class: 'seg' }, [...presetBtns, customBtn]);

  const customInput = el('input', {
    class: 'input', type: 'number', min: '1', max: String(FOCUS_MAX_MIN),
    placeholder: 'minutes', value: FOCUS_PRESETS.includes(presetMin) ? '' : String(presetMin),
    style: 'margin-top: 8px',
    oninput: () => {
      if (running) return;
      const n = Math.round(Number(customInput.value));
      if (!Number.isFinite(n) || n < 1) return;
      applyLength(Math.min(n, FOCUS_MAX_MIN));
      refreshActive({ custom: true });
    },
  });
  const customRow = el('div', { style: FOCUS_PRESETS.includes(presetMin) ? 'display: none' : '' }, [customInput]);
  refreshActive();

  function tick() {
    remainingSec = Math.max(0, Math.round((endAt - Date.now()) / 1000));
    display.textContent = fmtClock(remainingSec);
    if (remainingSec <= 0) {
      stopRun();
      playChime();
      toast('Focus session done — nice work', 'success');
    }
  }

  // Folds the just-run segment into sessionElapsedSec, then stops ticking.
  function stopRun() {
    if (!running) return;
    running = false;
    clearInterval(tickTimer);
    sessionElapsedSec += runStartRemaining - remainingSec;
    runStartRemaining = null;
    startPauseBtn.textContent = 'Start';
  }

  const startPauseBtn = el('button', {
    class: 'btn btn-primary',
    onclick: () => {
      if (running) {
        stopRun();
      } else {
        if (remainingSec <= 0) return;
        running = true;
        runStartRemaining = remainingSec;
        endAt = Date.now() + remainingSec * 1000;
        tickTimer = setInterval(tick, 250);
        startPauseBtn.textContent = 'Pause';
      }
    },
  }, 'Start');

  const resetBtn = el('button', {
    class: 'btn',
    onclick: () => {
      stopRun();
      remainingSec = presetMin * 60;
      display.textContent = fmtClock(remainingSec);
    },
  }, 'Reset');

  let notesTimer = null;
  // Note: a <textarea>'s value is its text content, NOT a `value` attribute —
  // so the existing note is passed as children here, not as `value:` (which
  // setAttribute would silently drop, loading the box empty and then wiping
  // the saved note on close).
  const notes = el('textarea', {
    class: 'input', rows: 4, placeholder: 'Notes for this session…',
    oninput: () => {
      clearTimeout(notesTimer);
      notesTimer = setTimeout(() => put('chores', { ...chore, notes: notes.value }), 800);
    },
  }, chore.notes || '');

  // Deep dive: Claudia drafts a concrete plan of attack for this task —
  // steps in order, rough times, what to have on hand, where it fits the next
  // two weeks — straight into the notes, so it's saved with the task.
  const diveStatus = el('span', { class: 'muted small' });
  const diveBtn = el('button', {
    class: 'link', style: 'padding: 4px 0; font-size: 13px',
    onclick: async () => {
      if (!hasApiKey()) return toast('Add a Claude API key in Settings', 'warn');
      diveBtn.disabled = 'disabled';
      diveStatus.textContent = ' Claudia is working out a plan…';
      try {
        const settings = getSettings();
        const ctx = await gatherContext({ start: todayStr(), days: 14, email: false });
        const text = await claudifyItem({
          family: (settings.familyMembers || 'Chris, Kat, Sedona, River').split(',').map((s) => s.trim()).filter(Boolean),
          notes: settings.householdNotes || DEFAULT_HOUSEHOLD_NOTES,
          events: ctx.eventsText,
          title: chore.title,
          detail: notes.value || '',
          kind: 'task',
        });
        notes.value = (notes.value ? notes.value.trimEnd() + '\n\n' : '') + text;
        await put('chores', { ...chore, notes: notes.value });
        diveStatus.textContent = '';
      } catch (err) {
        diveStatus.textContent = '';
        toast(err instanceof AIError ? err.message : `Something went wrong: ${err.message}`, 'error');
      }
      diveBtn.disabled = null;
    },
  }, '✨ Deep dive — have Claudia plan this task');

  const m = openModal(chore.title, [
    presetRow,
    customRow,
    display,
    loggedLine,
    el('div', { class: 'field-row', style: 'margin-top: 10px' }, [startPauseBtn, resetBtn]),
    el('label', { class: 'field-label', style: 'margin-top: 14px' }, 'Notes'),
    notes,
    el('div', {}, [diveBtn, diveStatus]),
  ], [
    el('button', { class: 'btn btn-primary', onclick: () => m.close() }, 'Done'),
  ], {
    onClose: async () => {
      stopRun();
      clearTimeout(notesTimer);
      if (sessionElapsedSec > 0 || notes.value !== (chore.notes || '')) {
        await put('chores', { ...chore, notes: notes.value, focusSeconds: (chore.focusSeconds || 0) + sessionElapsedSec });
        onchange?.();
      }
    },
  });
}

// Create/edit bottom sheet. Pass no chore (or an id-less prefill) to create.
// `onSaved(rec)` fires with the persisted record after a successful add/save
// (not on cancel/delete) — the add-from-suggestion flow uses it to record
// where the suggestion landed once the details are confirmed.
export async function editChoreModal(chore, onchange, { onSaved } = {}) {
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
  // Same note field the focus timer writes to (chore.notes) — surfaced here so
  // you can jot context the moment you open a task, not only from the timer.
  // A textarea's text is its children, NOT a `value` attribute (setAttribute
  // would silently drop it), so the existing note is passed as a child.
  const notes = el('textarea', { class: 'input', rows: 3, placeholder: 'Notes…' }, c.notes || '');

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
        const rec = await put('chores', {
          ...c,
          title: name,
          dueDate: due.value || null,
          assignee: assignee.value || null,
          notes: notes.value.trim() || null,
          done: c.done || false,
        });
        m.close();
        onSaved?.(rec);
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
    el('label', { class: 'field-label' }, 'Notes'),
    notes,
  ], actions);
  title.focus();
}

export async function renderChores(root) {
  clear(root);
  let chores = await getAll('chores');
  // Done tasks have an end state: kept ~60 days for reference (the Done
  // disclosure shows the recent 20), then pruned so the store doesn't grow
  // forever. Open tasks are never touched.
  const doneCutoff = new Date(Date.now() - 60 * 86400000).toISOString();
  // (doneAt must exist — a legacy done item without a timestamp is kept)
  for (const c of chores.filter((x) => x.done && x.doneAt && x.doneAt < doneCutoff)) {
    await remove('chores', c.id);
    chores = chores.filter((x) => x.id !== c.id);
  }
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

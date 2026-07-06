// maintenance.js — the recurring backbone: items with an interval, a
// last-done date, and a computed next-due. "Log done" resets the clock.

import { getAll, put, remove, deviceName } from './store.js';
import { el, clear, toast, openModal, todayStr, addDays, fmtDue } from './ui.js';
import { vendorsSection } from './vendors.js';

const INTERVAL_CHIPS = [
  [30, 'Monthly'],
  [90, 'Quarterly'],
  [180, 'Twice a year'],
  [365, 'Yearly'],
];

// Next due date (local YYYY-MM-DD). Never stored — always derived, so a
// merged lastDoneAt from the other phone can't leave a stale due date.
export function nextDue(item) {
  if (item.lastDoneAt) return addDays(item.lastDoneAt, item.intervalDays);
  if (item.seedDue) return item.seedDue;
  return addDays((item.createdAt || new Date().toISOString()).slice(0, 10), item.intervalDays);
}

export function dueState(item) {
  const due = nextDue(item);
  const today = todayStr();
  if (due < today) return 'overdue';
  if (due <= addDays(today, 7)) return 'soon';
  return 'ok';
}

export async function getMaintenance() {
  const items = await getAll('maintenance');
  return items.sort((a, b) => (nextDue(a) < nextDue(b) ? -1 : 1));
}

export async function logDone(item) {
  await put('maintenance', { ...item, lastDoneAt: todayStr(), lastDoneBy: deviceName() });
  toast(`${item.title} logged — next due ${fmtDue(addDays(todayStr(), item.intervalDays))}`, 'success');
}

export function duePill(item) {
  const state = dueState(item);
  const label = state === 'overdue' ? `overdue · was due ${fmtDue(nextDue(item))}` : `due ${fmtDue(nextDue(item))}`;
  return el('span', { class: 'pill' + (state === 'overdue' ? ' pill-overdue' : state === 'soon' ? ' pill-soon' : '') }, label);
}

// One maintenance row: title + due pill (+ last done), and a Log-done button.
export function maintenanceRow(item, { onchange, vendorById = {} } = {}) {
  const meta = [duePill(item)];
  meta.push(el('span', { class: 'pill' }, `every ${item.intervalDays}d`));
  if (item.vendorId && vendorById[item.vendorId]) {
    meta.push(el('span', { class: 'pill pill-accent' }, vendorById[item.vendorId].name));
  }
  if (item.lastDoneAt) {
    meta.push(el('span', { class: 'pill' }, `last ${fmtDue(item.lastDoneAt)}${item.lastDoneBy ? ' · ' + item.lastDoneBy : ''}`));
  }
  return el('div', { class: 'upkeep-row' }, [
    el('div', { class: 'upkeep-main', onclick: () => editMaintenanceModal(item, onchange) }, [
      el('span', { class: 'upkeep-title' }, item.title),
      el('span', { class: 'task-meta' }, meta),
    ]),
    el('button', {
      class: 'upkeep-done-btn',
      onclick: async () => {
        await logDone(item);
        onchange?.();
      },
    }, 'Log done'),
  ]);
}

// Create/edit bottom sheet. Pass no item (or an id-less prefill) to create.
export async function editMaintenanceModal(item, onchange) {
  const isNew = !item || !item.id;
  const it = item || {};
  const vendors = await getAll('vendors');

  const title = el('input', { class: 'input', placeholder: 'e.g. Replace HVAC filter', value: it.title || '' });
  const interval = el('input', { class: 'input', type: 'number', min: 1, max: 3650, value: it.intervalDays || 90 });
  const chips = el('div', { class: 'seg' }, INTERVAL_CHIPS.map(([days, label]) =>
    el('button', {
      class: 'btn seg-btn' + (Number(interval.value) === days ? ' active' : ''),
      onclick: (e) => {
        interval.value = days;
        e.currentTarget.parentElement.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b === e.currentTarget));
      },
    }, label)
  ));
  interval.addEventListener('input', () => chips.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active')));
  const seedDue = el('input', { class: 'input', type: 'date', value: it.seedDue || '' });
  const vendor = el('select', { class: 'input' }, [
    el('option', { value: '' }, 'No vendor'),
    ...vendors.map((v) => el('option', { value: v.id, selected: it.vendorId === v.id ? 'selected' : null }, v.name)),
  ]);
  const notes = el('textarea', { class: 'input', rows: 2, placeholder: 'Notes (filter size, gate code…)' }, it.notes || '');

  const actions = [
    !isNew &&
      el('button', {
        class: 'btn btn-danger',
        onclick: async () => {
          await remove('maintenance', it.id);
          toast('Maintenance item deleted');
          m.close();
          onchange?.();
        },
      }, 'Delete'),
    el('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
    el('button', {
      class: 'btn btn-primary',
      onclick: async () => {
        const name = title.value.trim();
        const days = parseInt(interval.value, 10);
        if (!name) return toast('Give it a title', 'warn');
        if (!(days > 0)) return toast('Set a repeat interval', 'warn');
        await put('maintenance', {
          ...it,
          title: name,
          intervalDays: days,
          seedDue: seedDue.value || null,
          vendorId: vendor.value || null,
          notes: notes.value.trim() || null,
        });
        m.close();
        onchange?.();
      },
    }, isNew ? 'Add item' : 'Save'),
  ];

  const m = openModal(isNew ? 'New maintenance item' : 'Edit maintenance item', [
    el('label', { class: 'field-label' }, 'What recurs?'),
    title,
    el('label', { class: 'field-label' }, 'Repeat every (days)'),
    chips,
    interval,
    el('div', { class: 'field-row' }, [
      el('div', {}, [el('label', { class: 'field-label' }, 'First due (optional)'), seedDue]),
      el('div', {}, [el('label', { class: 'field-label' }, 'Vendor (optional)'), vendor]),
    ]),
    notes,
  ], actions);
  title.focus();
}

// The Upkeep tab: maintenance schedule + the vendor directory — the
// "physical house" domain in one place.
export async function renderUpkeep(root) {
  clear(root);
  const rerender = () => renderUpkeep(root);
  const [items, vendors] = await Promise.all([getMaintenance(), getAll('vendors')]);
  const vendorById = Object.fromEntries(vendors.map((v) => [v.id, v]));

  root.append(
    el('div', { class: 'view-head-row' }, [
      el('h1', {}, 'Upkeep'),
      el('button', { class: 'btn btn-primary', onclick: () => editMaintenanceModal(null, rerender) }, '+ New item'),
    ]),
    el('div', { class: 'panel-head' }, [el('h4', {}, 'Maintenance schedule')]),
    el('section', { class: 'panel' },
      items.length
        ? items.map((it) => maintenanceRow(it, { onchange: rerender, vendorById }))
        : [el('p', { class: 'muted small' }, 'Nothing recurring yet. Filters, gutters, smoke-alarm batteries…')]
    ),
    ...(await vendorsSection(rerender))
  );
}

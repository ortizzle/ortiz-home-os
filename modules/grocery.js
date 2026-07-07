// grocery.js — the household list the app OWNS (Google Keep has no consumer
// API — see kickoff). Per-store lists, fast add, check-off, and a Keep
// paste-import.

import { getAll, put, remove, now } from './store.js';
import { el, clear, toast, todayStr } from './ui.js';

// The stores the family shops. Items keep a `store`; the list groups by it.
export const STORES = ['Costco', 'Walmart', "Trader Joe's"];

export async function getOpenGroceries() {
  const items = await getAll('groceries');
  return items.filter((g) => !g.gotAt);
}

// Items checked off today stay visible ("what we already grabbed"); older
// checked items are archive — kept in the store, hidden from the view.
function gotToday(g) {
  return g.gotAt && g.gotAt.slice(0, 10) === todayStr();
}

export async function addGroceryItem(name, store = STORES[0]) {
  const n = name.trim();
  if (!n) return null;
  return put('groceries', { name: n, store, gotAt: null });
}

// Parse a pasted Keep list: one item per line, tolerant of bullets,
// checkboxes, and markdown ("- [ ] milk", "• eggs", "* bread").
export function parseImport(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*•○☐☑☒]?\s*(\[\s*[xX]?\s*\])?\s*/, '').trim())
    .filter(Boolean);
}

function groceryRow(g, rerender) {
  return el('div', { class: 'grocery-row' + (g.gotAt ? ' got' : '') }, [
    el('button', {
      class: 'task-check',
      'aria-label': g.gotAt ? 'Put back' : 'Got it',
      html: g.gotAt ? '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>' : '',
      style: g.gotAt ? 'background: var(--accent); border-color: var(--accent)' : '',
      onclick: async () => {
        await put('groceries', { ...g, gotAt: g.gotAt ? null : now() });
        rerender();
      },
    }),
    el('span', { class: 'grocery-name' }, g.name),
    g.by ? el('span', { class: 'grocery-by' }, g.by) : null,
    el('button', {
      class: 'link',
      style: 'padding: 4px 6px; font-size: 15px; line-height: 1',
      'aria-label': 'Remove item',
      onclick: async () => {
        await remove('groceries', g.id);
        rerender();
      },
    }, '×'),
  ]);
}

// A horizontal store selector; returns { row, get() } where get() is the
// currently-chosen store.
function storePicker(initial) {
  let store = initial;
  const btns = STORES.map((s) =>
    el('button', {
      class: 'btn seg-btn' + (s === store ? ' active' : ''),
      onclick: (e) => {
        store = s;
        btns.forEach((b) => b.classList.toggle('active', b === e.currentTarget));
      },
    }, s)
  );
  return { row: el('div', { class: 'store-picker' }, btns), get: () => store };
}

export async function renderGrocery(root) {
  clear(root);
  const items = await getAll('groceries');
  const rerender = () => renderGrocery(root);

  const open = items.filter((g) => !g.gotAt).sort((a, b) => ((a.createdAt || '') < (b.createdAt || '') ? -1 : 1));
  const got = items.filter(gotToday);

  root.append(el('div', { class: 'view-head' }, [el('h1', {}, 'Grocery')]));

  // ----- fast add (with store) -----
  const picker = storePicker(STORES[0]);
  const input = el('input', { class: 'input', placeholder: 'Add an item…' });
  async function add() {
    if (!input.value.trim()) return;
    await addGroceryItem(input.value, picker.get());
    input.value = '';
    input.focus();
    rerender();
  }
  input.addEventListener('keydown', (e) => e.key === 'Enter' && add());
  root.append(
    el('section', { class: 'panel' }, [
      el('label', { class: 'field-label' }, 'Add to'),
      picker.row,
      el('div', { class: 'grocery-add' }, [input, el('button', { class: 'btn btn-primary', onclick: add }, 'Add')]),
    ])
  );

  // ----- per-store lists -----
  // Known stores in order, then any legacy/other store values still in use.
  const extras = [...new Set(open.map((g) => g.store).filter((s) => s && !STORES.includes(s)))].sort();
  const storeOrder = [...STORES, ...extras];

  if (!open.length) {
    root.append(el('section', { class: 'panel' }, [el('p', { class: 'muted small' }, 'Lists are empty. Add items above, or paste from Keep below.')]));
  } else {
    for (const s of storeOrder) {
      const list = open.filter((g) => (g.store || STORES[0]) === s);
      if (!list.length) continue;
      root.append(
        el('h4', { class: 'group-heading' }, `${s} (${list.length})`),
        el('section', { class: 'panel' }, list.map((g) => groceryRow(g, rerender)))
      );
    }
  }

  // ----- got today (combined) -----
  if (got.length) {
    root.append(
      el('h4', { class: 'group-heading' }, `In the cart today (${got.length})`),
      el('section', { class: 'panel' }, got.map((g) => groceryRow(g, rerender)))
    );
  }

  // ----- Keep paste-import (into a chosen store) -----
  const importPicker = storePicker(STORES[0]);
  const importArea = el('textarea', { class: 'input', rows: 4, placeholder: 'Open Google Keep → copy the list → paste here.\nOne item per line; bullets and checkboxes are fine.' });
  root.append(
    el('h4', { class: 'group-heading' }, 'Import from Keep'),
    el('section', { class: 'panel import-box' }, [
      el('label', { class: 'field-label' }, 'Import into'),
      importPicker.row,
      importArea,
      el('button', {
        class: 'btn',
        onclick: async () => {
          const names = parseImport(importArea.value);
          if (!names.length) return toast('Nothing to import', 'warn');
          for (const name of names) await addGroceryItem(name, importPicker.get());
          toast(`Imported ${names.length} item${names.length === 1 ? '' : 's'} to ${importPicker.get()}`, 'success');
          rerender();
        },
      }, 'Import items'),
      el('p', { class: 'muted small' }, 'Keep has no API for personal accounts, so this paste box is the bridge. Voice-added items land in Keep; paste them over before a store run.'),
    ])
  );
}

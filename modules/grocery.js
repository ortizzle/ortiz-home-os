// grocery.js — the household list the app OWNS (Google Keep has no consumer
// API — see kickoff). One flat list you can optionally group by store; each
// item carries its intended store but you can check it off anywhere.

import { getAll, put, remove, now } from './store.js';
import { el, clear, toast, todayStr, tableOfContents } from './ui.js';
import { dinnersSection } from './meals.js';

export const STORES = ['Costco', 'Walmart', "Trader Joe's"];
const SORT_KEY = 'ohos.grocerySort';

function getSort() { return localStorage.getItem(SORT_KEY) === 'store' ? 'store' : 'all'; }
function setSort(v) { localStorage.setItem(SORT_KEY, v); }

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

function groceryRow(g, rerender, { showStore = true } = {}) {
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
    showStore ? el('span', { class: 'pill grocery-store' }, g.store || STORES[0]) : null,
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

// Horizontal store selector for adding/importing. Returns { row, get() }.
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
  const [items, meals] = await Promise.all([getAll('groceries'), getAll('meals')]);
  const rerender = () => renderGrocery(root);

  const open = items.filter((g) => !g.gotAt).sort((a, b) => ((a.createdAt || '') < (b.createdAt || '') ? -1 : 1));
  const got = items.filter(gotToday);
  const sort = getSort();

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

  // ----- sort toggle + list -----
  if (open.length) {
    const sortBtn = (v, label) =>
      el('button', {
        class: 'btn seg-btn' + (sort === v ? ' active' : ''),
        // Keep your place instead of jumping to the top of the page.
        onclick: async () => { const y = window.scrollY; setSort(v); await rerender(); window.scrollTo(0, y); },
      }, label);
    root.append(
      el('div', { class: 'grocery-head' }, [
        el('h4', {}, `List (${open.length})`),
        el('div', { class: 'seg grocery-sort' }, [sortBtn('all', 'All'), sortBtn('store', 'By store')]),
      ])
    );

    if (sort === 'store') {
      const extras = [...new Set(open.map((g) => g.store).filter((s) => s && !STORES.includes(s)))].sort();
      for (const s of [...STORES, ...extras]) {
        const list = open.filter((g) => (g.store || STORES[0]) === s);
        if (!list.length) continue;
        root.append(
          el('h4', { class: 'group-heading store-heading' }, `${s} (${list.length})`),
          el('section', { class: 'panel' }, list.map((g) => groceryRow(g, rerender, { showStore: false })))
        );
      }
    } else {
      root.append(el('section', { class: 'panel' }, open.map((g) => groceryRow(g, rerender))));
    }
  } else {
    root.append(
      el('h4', { class: 'group-heading' }, 'List'),
      el('section', { class: 'panel' }, [el('p', { class: 'muted small' }, 'List is empty. Add items above, or paste from Keep below.')])
    );
  }

  // ----- got today -----
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

  // ----- the week's dinners (below the list — plan meals, they feed the list) -----
  root.append(...dinnersSection(meals, rerender));

  tableOfContents(root, [
    { label: 'List', at: 'List' },
    { label: 'Import', at: 'Import from Keep' },
    { label: 'Dinners', at: "This week's dinners" },
  ]);
}

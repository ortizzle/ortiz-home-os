// grocery.js — the household list the app OWNS (Google Keep has no consumer
// API — see kickoff). Fast add, Costco tag, check-off, and a paste-import
// box for lists voiced into Keep.

import { getAll, put, remove, now } from './store.js';
import { el, clear, toast, todayStr } from './ui.js';

export async function getOpenGroceries() {
  const items = await getAll('groceries');
  return items.filter((g) => !g.gotAt);
}

// Items checked off today stay visible ("what we already grabbed"); older
// checked items are archive — kept in the store, hidden from the view.
function gotToday(g) {
  return g.gotAt && g.gotAt.slice(0, 10) === todayStr();
}

export async function addGroceryItem(name, store = 'Costco') {
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
      class: 'task-check' + (g.gotAt ? '' : ''),
      'aria-label': g.gotAt ? 'Put back' : 'Got it',
      html: g.gotAt ? '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>' : '',
      style: g.gotAt ? 'background: var(--accent); border-color: var(--accent)' : '',
      onclick: async () => {
        await put('groceries', { ...g, gotAt: g.gotAt ? null : now() });
        rerender();
      },
    }),
    el('span', { class: 'grocery-name' }, g.name),
    g.store && g.store !== 'Costco' ? el('span', { class: 'pill' }, g.store) : null,
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

export async function renderGrocery(root) {
  clear(root);
  const items = await getAll('groceries');
  const rerender = () => renderGrocery(root);

  const open = items.filter((g) => !g.gotAt).sort((a, b) => ((a.createdAt || '') < (b.createdAt || '') ? -1 : 1));
  const got = items.filter(gotToday);

  root.append(el('div', { class: 'view-head' }, [el('h1', {}, 'Grocery')]));

  // ----- fast add -----
  let store = 'Costco';
  const input = el('input', { class: 'input', placeholder: 'Add an item…' });
  const storeBtn = el('button', {
    class: 'store-toggle costco',
    onclick: () => {
      store = store === 'Costco' ? 'Other' : 'Costco';
      storeBtn.textContent = store;
      storeBtn.classList.toggle('costco', store === 'Costco');
    },
  }, 'Costco');
  async function add() {
    if (!input.value.trim()) return;
    await addGroceryItem(input.value, store);
    input.value = '';
    input.focus();
    rerender();
  }
  input.addEventListener('keydown', (e) => e.key === 'Enter' && add());
  root.append(
    el('section', { class: 'panel' }, [
      el('div', { class: 'grocery-add' }, [input, storeBtn, el('button', { class: 'btn btn-primary', onclick: add }, 'Add')]),
    ])
  );

  // ----- open list -----
  root.append(
    el('h4', { class: 'group-heading' }, `List (${open.length})`),
    el('section', { class: 'panel' },
      open.length
        ? open.map((g) => groceryRow(g, rerender))
        : [el('p', { class: 'muted small' }, 'List is empty. Add items above, or paste from Keep below.')]
    )
  );

  // ----- got today -----
  if (got.length) {
    root.append(
      el('h4', { class: 'group-heading' }, `In the cart (${got.length})`),
      el('section', { class: 'panel' }, got.map((g) => groceryRow(g, rerender)))
    );
  }

  // ----- Keep paste-import -----
  const importArea = el('textarea', { class: 'input', rows: 4, placeholder: 'Open Google Keep → copy the list → paste here.\nOne item per line; bullets and checkboxes are fine.' });
  root.append(
    el('h4', { class: 'group-heading' }, 'Import from Keep'),
    el('section', { class: 'panel import-box' }, [
      importArea,
      el('button', {
        class: 'btn',
        onclick: async () => {
          const names = parseImport(importArea.value);
          if (!names.length) return toast('Nothing to import', 'warn');
          for (const name of names) await addGroceryItem(name, 'Costco');
          toast(`Imported ${names.length} item${names.length === 1 ? '' : 's'}`, 'success');
          rerender();
        },
      }, 'Import items'),
      el('p', { class: 'muted small' }, 'Keep has no API for personal accounts, so this paste box is the bridge. Voice-added items land in Keep; paste them over before Costco day.'),
    ])
  );
}

// app.js — boot, hash router, view switching, settings view.

import {
  initStore,
  getAll,
  getSettings,
  saveSettings,
  syncConfigured,
  pullFromGist,
  pushToGist,
  onSyncStatus,
  exportSnapshot,
} from './modules/store.js';
import { renderDashboard } from './modules/dashboard.js';
import { renderChores } from './modules/chores.js';
import { renderGrocery } from './modules/grocery.js';
import { renderCalendar } from './modules/calendar.js';
import { renderUpkeep } from './modules/maintenance.js';
import { errandWindow } from './modules/suggest.js';
import { el, clear, toast, navigate, todayStr } from './modules/ui.js';

const view = document.getElementById('view');

// ---------- theme ----------

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

export const ACCENTS = ['blue', 'teal', 'indigo', 'plum', 'amber'];

function applyTheme() {
  const s = getSettings();
  const pref = s.theme || 'auto';
  const dark = pref === 'dark' || (pref === 'auto' && darkQuery.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.accent = ACCENTS.includes(s.accent) ? s.accent : 'blue';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#0f1513' : '#f7f9f8');
}

darkQuery.addEventListener('change', () => {
  if ((getSettings().theme || 'auto') === 'auto') applyTheme();
});

// Route table: hash pattern → handler.
const routes = [
  { re: /^#\/home$/, tab: 'home', fn: () => renderDashboard(view) },
  { re: /^#\/tasks$/, tab: 'tasks', fn: () => renderChores(view) },
  { re: /^#\/grocery$/, tab: 'grocery', fn: () => renderGrocery(view) },
  { re: /^#\/calendar$/, tab: 'calendar', fn: () => renderCalendar(view, { mode: 'day', date: todayStr() }) },
  { re: /^#\/calendar\/(day|week)\/(\d{4}-\d{2}-\d{2})$/, tab: 'calendar', fn: (m) => renderCalendar(view, { mode: m[1], date: m[2] }) },
  { re: /^#\/upkeep$/, tab: 'upkeep', fn: () => renderUpkeep(view) },
  { re: /^#\/settings$/, tab: 'settings', fn: () => renderSettings(view) },
];

function setActiveTab(tab) {
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });
}

// Grocery tab badge: open-item count, shown only in the errand window —
// the "you're about to be at Costco" signal, not a constant nag.
async function refreshBadges() {
  const tab = document.querySelector('.tab[data-tab="grocery"]');
  if (!tab) return;
  tab.querySelector('.tab-badge')?.remove();
  if (!errandWindow(getSettings())) return;
  const groceries = await getAll('groceries');
  const open = groceries.filter((g) => !g.gotAt).length;
  if (open) tab.append(el('span', { class: 'tab-badge' }, open > 99 ? '99+' : open));
}

async function router() {
  const hash = location.hash || '#/home';
  const match = routes.find((r) => r.re.test(hash));
  if (!match) return navigate('#/home');
  setActiveTab(match.tab);
  window.scrollTo(0, 0);
  try {
    await match.fn(hash.match(match.re));
  } catch (err) {
    console.error(err);
    clear(view).append(el('p', { class: 'empty' }, `Something broke: ${err.message}`));
  }
  refreshBadges();
}

// ---------- Settings view ----------

const DAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function renderSettings(root) {
  clear(root);
  const s = getSettings();

  const deviceNameInput = el('input', { class: 'input', placeholder: 'e.g. Chris', value: s.deviceName || '' });
  const gistToken = el('input', { class: 'input', type: 'password', placeholder: 'GitHub token (gist scope)', value: s.gistToken || '' });
  const gistId = el('input', { class: 'input', placeholder: 'Gist ID', value: s.gistId || '' });

  const status = el('span', { class: 'sync-dot ' + (syncConfigured() ? 'on' : 'off') });
  const statusText = el('span', { class: 'muted' }, syncConfigured() ? 'Sync configured' : 'Local-only (no sync)');

  let errandDays = [...(s.errandDays || [6])];
  const dayRow = el('div', { class: 'day-row' }, DAY_LABELS.map((label, i) =>
    el('button', {
      class: 'day-dot' + (errandDays.includes(i) ? ' on' : ''),
      onclick: (e) => {
        errandDays = errandDays.includes(i) ? errandDays.filter((d) => d !== i) : [...errandDays, i];
        e.currentTarget.classList.toggle('on');
      },
    }, label)
  ));

  const themePref = s.theme || 'auto';
  const themeBtn = (value, label) =>
    el('button', {
      class: 'btn seg-btn' + (themePref === value ? ' active' : ''),
      onclick: () => {
        saveSettings({ theme: value });
        applyTheme();
        renderSettings(root);
      },
    }, label);

  root.append(
    el('header', { class: 'view-head' }, [el('h1', {}, 'Settings')]),

    el('section', { class: 'panel' }, [
      el('h4', {}, 'This device'),
      el('label', { class: 'field-label' }, 'Your name (stamps who added/did what)'),
      deviceNameInput,
      el('label', { class: 'field-label' }, 'Errand day(s) — when the grocery list surfaces'),
      dayRow,
    ]),

    el('section', { class: 'panel' }, [
      el('h4', {}, 'Appearance'),
      el('div', { class: 'seg' }, [
        themeBtn('auto', 'Auto'),
        themeBtn('light', 'Light'),
        themeBtn('dark', 'Dark'),
      ]),
      el('label', { class: 'field-label' }, 'Accent color'),
      el('div', { class: 'accent-row' }, ACCENTS.map((a) =>
        el('button', {
          class: 'accent-dot accent-' + a + ((s.accent || 'blue') === a ? ' active' : ''),
          title: a,
          onclick: () => {
            saveSettings({ accent: a });
            applyTheme();
            renderSettings(root);
          },
        })
      )),
    ]),

    el('section', { class: 'panel' }, [
      el('h4', {}, 'Household sync'),
      el('div', { class: 'sync-status' }, [status, statusText]),
      el('label', { class: 'field-label' }, 'GitHub token (gist scope)'),
      gistToken,
      el('label', { class: 'field-label' }, 'Gist ID'),
      gistId,
      el('p', { class: 'muted small' }, 'One private Gist for the household — configure the SAME token and Gist ID on both phones and everything merges. Deletions stay deleted (tombstones).'),
    ]),

    el('div', { class: 'settings-actions' }, [
      el('button', { class: 'btn btn-primary', onclick: onSave }, 'Save'),
      el('button', { class: 'btn', onclick: onSyncNow, disabled: syncConfigured() ? null : 'disabled' }, 'Sync now'),
      el('button', { class: 'btn', onclick: onExport }, 'Export JSON'),
    ])
  );

  async function onSave() {
    saveSettings({
      deviceName: deviceNameInput.value.trim(),
      errandDays: errandDays.sort(),
      gistToken: gistToken.value.trim(),
      gistId: gistId.value.trim(),
    });
    toast('Settings saved', 'success');
    renderSettings(root);
  }

  async function onSyncNow() {
    if (!syncConfigured()) return;
    toast('Syncing…');
    await pullFromGist();
    await pushToGist();
    toast('Synced', 'success');
  }

  async function onExport() {
    const snapshot = await exportSnapshot();
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: 'ortiz-home-os-backup.json' });
    a.click();
    URL.revokeObjectURL(url);
  }
}

// ---------- boot ----------

async function boot() {
  applyTheme();

  // Register the service worker FIRST: even if the rest of boot crashes,
  // the browser can still pick up a fixed version on the next load.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW failed', e));
  }

  onSyncStatus((st) => {
    const dot = document.getElementById('header-sync');
    if (dot) dot.className = 'header-sync ' + st;
  });

  // A storage failure must degrade, never blank the app.
  try {
    await initStore();
  } catch (err) {
    console.error('initStore failed', err);
    toast(`Storage error — some data may be unavailable (${err?.message || err})`, 'error');
  }

  // First run: get the device name set so attribution works from record one.
  if (!getSettings().deviceName && !location.hash) {
    navigate('#/settings');
  }

  window.addEventListener('hashchange', router);
  await router();
}

boot();

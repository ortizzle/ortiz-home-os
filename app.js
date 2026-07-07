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
import { renderManager } from './modules/manager.js';
import { renderMeeting } from './modules/meeting.js';
import { DEFAULT_HOUSEHOLD_NOTES, DEFAULT_FOOD_NOTES, DEFAULT_KIDS } from './modules/hmcontext.js';
import { isConnected as gcalConnected, canReadEmail as gcalCanEmail, connect as gcalConnect, disconnect as gcalDisconnect, GcalError, listCalendars, getSelectedCalendars, setSelectedCalendars } from './modules/gcal.js';
import { errandWindow } from './modules/suggest.js';
import { el, clear, toast, navigate, openModal, todayStr, tableOfContents } from './modules/ui.js';

const view = document.getElementById('view');

// Shown in Settings so any phone can be checked at a glance. Keep in step
// with the sw.js CACHE version when shipping.
const APP_VERSION = 'v19';

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
  { re: /^#\/manager$/, tab: 'manager', fn: () => renderManager(view) },
  { re: /^#\/upkeep$/, tab: 'manager', fn: () => renderManager(view) }, // legacy alias
  { re: /^#\/meeting$/, tab: 'meeting', fn: () => renderMeeting(view) },
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
const FULL_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function renderSettings(root) {
  clear(root);
  const s = getSettings();

  const deviceNameInput = el('input', { class: 'input', placeholder: 'e.g. Chris', value: s.deviceName || '' });
  const familyInput = el('input', { class: 'input', placeholder: 'Chris, Cat, Sedona, River', value: s.familyMembers || 'Chris, Cat, Sedona, River' });
  const meetingDaySel = el('select', { class: 'input' }, DAY_LABELS.map((_, i) =>
    el('option', { value: i, selected: Number(s.meetingDay ?? 3) === i ? 'selected' : null }, FULL_DAYS[i])
  ));
  const apiKey = el('input', { class: 'input', type: 'password', placeholder: 'sk-ant-...', value: s.apiKey || '' });
  const householdNotes = el('textarea', { class: 'input', rows: 4 }, s.householdNotes ?? DEFAULT_HOUSEHOLD_NOTES);
  const interestsInput = el('input', { class: 'input', placeholder: 'e.g. movies, hiking, board games, live music', value: s.familyInterests || '' });
  const cityInput = el('input', { class: 'input', placeholder: 'e.g. Phoenix, AZ', value: s.homeCity || '' });
  const foodNotes = el('textarea', { class: 'input', rows: 3 }, s.foodNotes ?? DEFAULT_FOOD_NOTES);
  const kidsInput = el('input', { class: 'input', placeholder: 'e.g. Sedona 11, River 9', value: s.kidsAges ?? DEFAULT_KIDS });
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
      el('h4', {}, 'Family & meeting'),
      el('label', { class: 'field-label' }, 'Family members (comma-separated)'),
      familyInput,
      el('label', { class: 'field-label' }, 'Family meeting day'),
      meetingDaySel,
    ]),

    el('section', { class: 'panel' }, [
      el('h4', {}, 'Claudia — AI house manager (optional)'),
      el('label', { class: 'field-label' }, 'Claude API key (stored only on this device)'),
      apiKey,
      el('label', { class: 'field-label' }, 'Notes for the assistant (habits, preferences)'),
      householdNotes,
      el('label', { class: 'field-label' }, 'Family interests — for fun ideas (movies, events…)'),
      interestsInput,
      el('label', { class: 'field-label' }, 'City / area — for finding what’s on nearby'),
      cityInput,
      el('label', { class: 'field-label' }, 'Food rules — for the dinner planner'),
      foodNotes,
      el('label', { class: 'field-label' }, 'Kids & ages — for age-fit chore ideas'),
      kidsInput,
      el('p', { class: 'muted small' }, 'Claudia (powered by Claude) runs the daily brief, weekly review, dinner plans, meeting drafts, and Ask. Notes are background context so her ideas fit your family; interests + city let her search the web for real nearby things — a movie you’d love this week, local events — with actual dates and times. Used for direct browser calls to Anthropic; never leaves your device except to Anthropic.'),
    ]),

    el('section', { class: 'panel' }, [
      el('h4', {}, 'Google (Calendar + Email, optional)'),
      el('div', { class: 'sync-status' }, [
        el('span', { class: 'sync-dot ' + (gcalConnected() ? 'on' : 'off') }),
        el('span', { class: 'muted' }, gcalConnected() ? (gcalCanEmail() ? 'Connected — calendar + email (read-only)' : 'Connected — calendar only') : 'Not connected'),
      ]),
      gcalConnected() && !gcalCanEmail()
        ? el('p', { class: 'muted small', style: 'color: var(--accent)' }, 'Reconnect to grant Gmail read access so Claudia can factor recent email into your brief and answers.')
        : null,
      gcalConnected()
        ? el('div', { class: 'settings-actions' }, [
            el('button', { class: 'btn btn-primary', onclick: () => chooseCalendars(() => renderSettings(root)) }, 'Choose calendars'),
            gcalCanEmail() ? null : el('button', {
              class: 'btn btn-primary',
              onclick: async (e) => {
                const b = e.currentTarget;
                b.disabled = 'disabled';
                b.textContent = 'Reconnecting…';
                try { await gcalConnect(); toast('Reconnected', 'success'); renderSettings(root); }
                catch (err) { toast(err instanceof GcalError ? `Couldn't reconnect: ${err.message}` : 'Cancelled', 'warn'); b.disabled = null; b.textContent = 'Reconnect for email'; }
              },
            }, 'Reconnect for email'),
            el('button', { class: 'btn', onclick: () => { gcalDisconnect(); toast('Disconnected'); renderSettings(root); } }, 'Disconnect'),
          ])
        : el('button', {
            class: 'btn btn-primary',
            onclick: async (e) => {
              const b = e.currentTarget;
              b.disabled = 'disabled';
              b.textContent = 'Connecting…';
              try {
                await gcalConnect();
                toast('Google Calendar connected', 'success');
                renderSettings(root);
              } catch (err) {
                toast(err instanceof GcalError ? `Couldn't connect: ${err.message}` : 'Connection cancelled', 'warn');
                b.disabled = null;
                b.textContent = 'Connect Google Calendar';
              }
            },
          }, 'Connect Google Calendar'),
      el('p', { class: 'muted small' }, 'Read-only overlay of your family Google Calendar (Family + Personal Schedule) on the Calendar and Meeting tabs, plus read-only access to recent Gmail so Claudia can factor email into your morning brief and answers. The app can only read — it never changes your calendar or sends mail. Sign in again occasionally (Google access expires ~hourly).'),
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
    ]),

    el('p', { class: 'muted small center', style: 'margin-top: 18px' }, `Ortiz Home OS ${APP_VERSION}`)
  );

  tableOfContents(root, [
    { label: 'Device', at: 'This device' },
    { label: 'Family', at: 'Family & meeting' },
    { label: 'Claudia', at: 'Claudia' },
    { label: 'Google', at: 'Google' },
    { label: 'Theme', at: 'Appearance' },
    { label: 'Sync', at: 'Household sync' },
  ]);

  async function onSave() {
    saveSettings({
      deviceName: deviceNameInput.value.trim(),
      errandDays: errandDays.sort(),
      familyMembers: familyInput.value.trim(),
      meetingDay: Number(meetingDaySel.value),
      apiKey: apiKey.value.trim(),
      householdNotes: householdNotes.value.trim(),
      familyInterests: interestsInput.value.trim(),
      homeCity: cityInput.value.trim(),
      foodNotes: foodNotes.value.trim(),
      kidsAges: kidsInput.value.trim(),
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

// Calendar picker — fetches this account's Google calendars and lets the user
// choose which overlay on the app (stored per device).
async function chooseCalendars(afterSave) {
  toast('Loading your calendars…');
  let cals;
  try {
    cals = await listCalendars();
  } catch (err) {
    return toast('Could not load your calendars', 'error');
  }
  if (!cals.length) return toast('No calendars found', 'warn');

  const selected = new Set(getSelectedCalendars());
  const rows = cals.map((c) => {
    const cb = el('input', { type: 'checkbox', checked: selected.has(c.id) ? 'checked' : null });
    cb.dataset.calId = c.id;
    return el('label', { class: 'check-label' }, [cb, c.summary + (c.primary ? ' (primary)' : '')]);
  });

  const m = openModal('Calendars to show', [
    el('p', { class: 'muted small', style: 'margin-top:0' }, 'Pick which Google calendars overlay on the Calendar and Meeting tabs. Choice is per device.'),
    ...rows,
  ], [
    el('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
    el('button', {
      class: 'btn btn-primary',
      onclick: () => {
        const chosen = rows.map((r) => r.querySelector('input')).filter((cb) => cb.checked).map((cb) => cb.dataset.calId);
        setSelectedCalendars(chosen);
        toast('Calendars updated', 'success');
        m.close();
        afterSave?.();
      },
    }, 'Save'),
  ]);
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

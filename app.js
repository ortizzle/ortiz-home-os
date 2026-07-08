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
import { DEFAULT_HOUSEHOLD_NOTES, DEFAULT_FOOD_NOTES, DEFAULT_KIDS, getSuggestionMemory } from './modules/hmcontext.js';
import { isConnected as gcalConnected, everConnected as gcalEverConnected, silentRenew as gcalSilentRenew, canReadEmail as gcalCanEmail, connect as gcalConnect, disconnect as gcalDisconnect, GcalError, listCalendars, getSelectedCalendars, setSelectedCalendars } from './modules/gcal.js';
import { errandWindow } from './modules/suggest.js';
import { diagnosticsSection } from './modules/diag.js';
import { el, clear, toast, navigate, openModal, todayStr, fmtDay, tableOfContents, disclosure } from './modules/ui.js';

const view = document.getElementById('view');

// Shown in Settings so any phone can be checked at a glance. Keep in step
// with the sw.js CACHE version when shipping.
const APP_VERSION = 'v36';

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
  { re: /^#\/meeting$/, tab: 'manager', fn: () => renderMeeting(view) }, // meeting lives on the Claudia tab now
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
const DEFAULT_FAMILY_TIME = 'after dinner';
const DEFAULT_ADMIN_TIME = 'after 8pm';
const DEFAULT_ADMIN_ATTENDEES = 'Chris, Kat';

// Read-only recap of everything that shapes Claudia: the fields above,
// plus what she's picked up from actual use (accepted suggestions, answered
// questions, things suggested repeatedly but never taken). Settings →
// Export JSON has the raw data; this is the readable version.
function memorySection(s, memory) {
  const row = (label, value, wrap = false) =>
    value ? el('p', { class: 'muted small', style: `margin: 2px 0${wrap ? '; white-space: pre-wrap' : ''}` }, [el('strong', {}, label + ': '), value]) : null;

  const heading = (text) => el('h5', { style: 'margin: 12px 0 4px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-2)' }, text);

  const memNodes = [];
  if (memory.resolved.length) {
    memNodes.push(
      heading('Questions you’ve answered'),
      el('ul', { class: 'meeting-list' }, memory.resolved.map((r) =>
        el('li', {}, [el('strong', {}, r.question), r.answer ? ` — ${r.answer}` : ' — resolved'])
      ))
    );
  }
  if (memory.added.length) {
    memNodes.push(
      heading('Suggestions you’ve added'),
      el('ul', { class: 'meeting-list' }, memory.added.slice(0, 15).map((a) =>
        el('li', {}, `${a.title} — added ${fmtDay(a.addedAt)}${a.done ? ', done ✓' : ''}`)
      ))
    );
  }
  if (memory.repeated.length) {
    memNodes.push(
      heading('Suggested more than once, not added'),
      el('ul', { class: 'meeting-list' }, memory.repeated.map((r) => el('li', {}, `${r.title} (×${r.shownCount})`)))
    );
  }
  if (!memNodes.length) {
    memNodes.push(el('p', { class: 'muted small' }, 'No follow-through history yet — this fills in as you use Ask, the weekly review, and the daily brief.'));
  }

  return disclosure('What Claudia knows', el('section', { class: 'panel' }, [
    el('p', { class: 'muted small', style: 'margin-top: 0' }, 'A readable recap of what shapes Claudia’s answers — the fields above, plus what she’s picked up from actual use. Settings → Export JSON has the full raw data.'),
    row('Family', s.familyMembers || 'Chris, Kat, Sedona, River'),
    row('Kids & ages', s.kidsAges || DEFAULT_KIDS),
    row('Interests', s.familyInterests || '(not set)'),
    row('City', s.homeCity || '(not set)'),
    row('Food rules', s.foodNotes || DEFAULT_FOOD_NOTES, true),
    row('Household notes', s.householdNotes || DEFAULT_HOUSEHOLD_NOTES, true),
    ...memNodes,
  ]));
}

async function renderSettings(root) {
  clear(root);
  const s = getSettings();
  const memory = await getSuggestionMemory();

  const deviceNameInput = el('input', { class: 'input', placeholder: 'e.g. Chris', value: s.deviceName || '' });
  const familyInput = el('input', { class: 'input', placeholder: 'Chris, Kat, Sedona, River', value: s.familyMembers || 'Chris, Kat, Sedona, River' });
  const daySelect = (settingKey, defaultDay) => el('select', { class: 'input' }, DAY_LABELS.map((_, i) =>
    el('option', { value: i, selected: Number(s[settingKey] ?? defaultDay) === i ? 'selected' : null }, FULL_DAYS[i])
  ));
  const meetingDaySel = daySelect('meetingDay', 3); // Family — default Wednesday
  const adminDaySel = daySelect('adminMeetingDay', 4); // Admin — default Thursday
  const familyTimeInput = el('input', { class: 'input', placeholder: 'e.g. after dinner', value: s.familyMeetingTime ?? DEFAULT_FAMILY_TIME });
  const adminTimeInput = el('input', { class: 'input', placeholder: 'e.g. after 8pm', value: s.adminMeetingTime ?? DEFAULT_ADMIN_TIME });
  const adminAttendeesInput = el('input', { class: 'input', placeholder: 'e.g. Chris, Kat', value: s.adminAttendees || DEFAULT_ADMIN_ATTENDEES });
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

    // ----- you & this device: identity + look, purely local, no sync -----
    disclosure('This device', el('section', { class: 'panel' }, [
      el('label', { class: 'field-label' }, 'Your name (stamps who added/did what)'),
      deviceNameInput,
      el('label', { class: 'field-label' }, 'Errand day(s) — when the grocery list surfaces'),
      dayRow,
    ]), { open: true }),

    disclosure('Appearance', el('section', { class: 'panel' }, [
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
    ])),

    // ----- the household: who's in it, and when it meets -----
    disclosure('Family & meeting', el('section', { class: 'panel' }, [
      el('label', { class: 'field-label' }, 'Family members (comma-separated)'),
      familyInput,
      el('p', { class: 'muted small', style: 'margin: 14px 0 4px; font-weight: 600' }, 'Family meeting — kids included, icebreakers + fun family connections'),
      el('div', { class: 'field-row' }, [
        el('div', {}, [el('label', { class: 'field-label' }, 'Day'), meetingDaySel]),
        el('div', {}, [el('label', { class: 'field-label' }, 'Time'), familyTimeInput]),
      ]),
      el('p', { class: 'muted small', style: 'margin: 14px 0 4px; font-weight: 600' }, 'Admin meeting — just the two of you, core household items'),
      el('div', { class: 'field-row' }, [
        el('div', {}, [el('label', { class: 'field-label' }, 'Day'), adminDaySel]),
        el('div', {}, [el('label', { class: 'field-label' }, 'Time'), adminTimeInput]),
      ]),
      el('label', { class: 'field-label' }, 'Admin attendees'),
      adminAttendeesInput,
    ])),

    // ----- Claudia: her config, then what she's learned -----
    disclosure('Claudia — AI house manager (optional)', el('section', { class: 'panel' }, [
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
      el('label', { class: 'field-label' }, 'Kids & ages — for age-fit task ideas'),
      kidsInput,
      el('p', { class: 'muted small' }, 'Claudia (powered by Claude) runs the daily brief, weekly review, dinner plans, meeting drafts, and Ask. Notes are background context so her ideas fit your family; interests + city let her search the web for real nearby things — a movie you’d love this week, local events — with actual dates and times. Used for direct browser calls to Anthropic; never leaves your device except to Anthropic.'),
    ])),

    memorySection(s, memory),

    // ----- integrations -----
    disclosure('Google (Calendar + Email, optional)', el('section', { class: 'panel' }, [
      el('div', { class: 'sync-status' }, [
        el('span', { class: 'sync-dot ' + (gcalConnected() ? 'on' : 'off') }),
        el('span', { class: 'muted' }, gcalConnected()
          ? (gcalCanEmail() ? 'Connected — calendar + email (read-only)' : 'Connected — calendar only')
          : (gcalEverConnected() ? 'Session expired — renews on next use, or reconnect (one tap)' : 'Not connected')),
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
              const label = b.textContent;
              b.disabled = 'disabled';
              b.textContent = 'Connecting…';
              try {
                await gcalConnect();
                toast('Google Calendar connected', 'success');
                renderSettings(root);
              } catch (err) {
                toast(err instanceof GcalError ? `Couldn't connect: ${err.message}` : 'Connection cancelled', 'warn');
                b.disabled = null;
                b.textContent = label;
              }
            },
          }, gcalEverConnected() ? 'Reconnect Google (one tap)' : 'Connect Google Calendar'),
      el('p', { class: 'muted small' }, 'Read-only overlay of your family Google Calendar (Family + Personal Schedule) on the Calendar and Meeting tabs, plus read-only access to recent Gmail so Claudia can factor email into your morning brief and answers. The app can only read — it never changes your calendar or sends mail. Google access expires hourly, but the app renews it silently in the background — you should only need to sign in again after clearing browser data or on a new device.'),
    ])),

    // ----- sync infrastructure + actions -----
    disclosure('Household sync', el('section', { class: 'panel' }, [
      el('div', { class: 'sync-status' }, [status, statusText]),
      el('label', { class: 'field-label' }, 'GitHub token (gist scope)'),
      gistToken,
      el('label', { class: 'field-label' }, 'Gist ID'),
      gistId,
      el('p', { class: 'muted small' }, 'One private Gist for the household — configure the SAME token and Gist ID on both phones and everything merges. Deletions stay deleted (tombstones).'),
    ])),

    el('div', { class: 'settings-actions' }, [
      el('button', { class: 'btn btn-primary', onclick: onSave }, 'Save'),
      el('button', { class: 'btn', onclick: onSyncNow, disabled: syncConfigured() ? null : 'disabled' }, 'Sync now'),
      el('button', { class: 'btn', onclick: onExport }, 'Export JSON'),
    ]),

    diagnosticsSection(APP_VERSION),

    el('p', { class: 'muted small center', style: 'margin-top: 18px' }, `Ortiz Home OS ${APP_VERSION}`)
  );

  tableOfContents(root, [
    { label: 'Device', at: 'This device' },
    { label: 'Theme', at: 'Appearance' },
    { label: 'Family', at: 'Family & meeting' },
    { label: 'Claudia', at: 'Claudia' },
    { label: 'Memory', at: 'What Claudia knows' },
    { label: 'Google', at: 'Google' },
    { label: 'Sync', at: 'Household sync' },
    { label: 'Debug', at: 'Diagnostics' },
  ]);

  async function onSave() {
    saveSettings({
      deviceName: deviceNameInput.value.trim(),
      errandDays: errandDays.sort(),
      familyMembers: familyInput.value.trim(),
      meetingDay: Number(meetingDaySel.value),
      adminMeetingDay: Number(adminDaySel.value),
      familyMeetingTime: familyTimeInput.value.trim(),
      adminMeetingTime: adminTimeInput.value.trim(),
      adminAttendees: adminAttendeesInput.value.trim(),
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
    // pull/push swallow errors internally and report via the status dot —
    // read it back so this toast tells the truth.
    const ok = document.getElementById('header-sync')?.classList.contains('synced');
    toast(ok ? 'Synced' : 'Sync had trouble — check connection and token', ok ? 'success' : 'warn');
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

  // Renew an expired Google session in the background (no prompting; a
  // blocked popup just resolves false). When it works, the calendar overlay
  // and email are simply live again without anyone tapping anything.
  gcalSilentRenew().then((ok) => { if (ok) router(); }).catch(() => {});

  // Two-user household: without this, a task Chris marks done on his phone
  // sits in the Gist until Kat's phone happens to relaunch or she taps Sync
  // Now — her already-open session just keeps showing the stale state. Pull
  // quietly (a) whenever the app regains focus and (b) every 45s while
  // visible. Re-render ONLY when the pull actually changed something, never
  // while someone is mid-typing or has a modal open, and without losing the
  // scroll position — a background refresh must be invisible unless it has
  // news.
  async function backgroundSync() {
    if (!syncConfigured() || document.visibilityState !== 'visible') return;
    const changed = await pullFromGist();
    if (!changed) return;
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    const modalOpen = Boolean(document.querySelector('.modal-overlay'));
    if (typing || modalOpen) return; // next tick will catch it
    const y = window.scrollY;
    await router();
    window.scrollTo(0, y);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') backgroundSync();
  });
  const bgSyncTimer = setInterval(backgroundSync, 45_000);
  window.addEventListener('beforeunload', () => clearInterval(bgSyncTimer));
}

boot();

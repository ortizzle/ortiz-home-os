// calendar.js — day and week views: appointments and tasks due. Ported from
// Focus OS. Month view: not in v1. Google Calendar read-overlay: v1.5 — keep
// rendering composable so overlay events can slot into these same lists.
// Recurring upkeep is a plain Calendar appointment now — no separate
// maintenance-schedule feature.

import { getAll, put, remove } from './store.js';
import { el, clear, toast, navigate, openModal, todayStr, addDays, parseDate, dateStr, fmtDay, onSwipe, preserveScroll } from './ui.js';
import { choreRow, editChoreModal } from './chores.js';
import { isConnected, everConnected, connect, eventsForRange, GcalError, canWrite, writableCalendars, createEvent, getWriteCalendar, setWriteCalendar } from './gcal.js';

// A "Connect Google Calendar" prompt, shown when not yet connected. First
// connect shows Google's consent; after that (session merely expired and the
// silent renewal couldn't run) it's a single tap with a self-closing popup.
function gcalConnectBar(rerender) {
  const label = everConnected() ? 'Reconnect Google (one tap)' : 'Connect Google Calendar';
  const btn = el('button', {
    class: 'btn btn-primary full',
    onclick: async () => {
      btn.disabled = 'disabled';
      btn.textContent = 'Connecting…';
      try {
        await connect();
        toast('Google Calendar connected', 'success');
        rerender();
      } catch (err) {
        toast(err instanceof GcalError ? `Couldn't connect: ${err.message}` : 'Connection cancelled', 'warn');
        btn.disabled = null;
        btn.textContent = label;
      }
    },
  }, label);
  return el('div', {}, [btn, el('p', { class: 'muted small', style: 'margin-top:-8px' }, 'Read-only — overlays your family Google Calendar events here. The app can never change your calendar.')]);
}

// Merge stored appointments with live Google events for a range. When
// connected, live events replace the old persisted gcal mirror (so they don't
// double up); when NOT connected, the mirror stays visible as a fallback so
// nobody loses their calendar before they've tapped Connect.
export async function appointmentsFor(start, end) {
  const connected = isConnected();
  const [stored, live] = await Promise.all([
    getAll('appointments'),
    connected ? eventsForRange(start, end).catch(() => []) : Promise.resolve([]),
  ]);
  const base = connected ? stored.filter((a) => a.source !== 'gcal') : stored;
  // De-dupe a local appointment against a live Google event with the same
  // title/date/time — catches leftover copies from before Google was
  // connected (or the old weekly mirror) now shadowed by the live one. Live
  // wins, since it reflects the real calendar; genuinely distinct events
  // (different titles/times) are untouched either way.
  const key = (a) => `${(a.title || '').trim().toLowerCase()}|${a.date}|${a.allDay ? 'allday' : (a.startTime || '')}`;
  const seen = new Set(live.map(key));
  const dedupedBase = base.filter((a) => {
    const k = key(a);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return [...dedupedBase, ...live];
}

function fmtTime(t) {
  // "14:30" → "2:30 PM"
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${ampm}`;
}

function apptTimeLabel(a) {
  if (a.allDay || !a.startTime) return 'All day';
  return a.endTime ? `${fmtTime(a.startTime)}–${fmtTime(a.endTime)}` : fmtTime(a.startTime);
}

// Create/edit bottom sheet. `preset` seeds fields for contextual creation.
// When creating a new appointment with Google write access, a "Save to"
// picker lets the event go straight onto a Google calendar (default: Family)
// instead of Home OS.
export async function editAppointmentModal(appointment, date, onchange, preset = {}) {
  const isNew = !appointment;
  const a = appointment || { date, ...preset };

  const title = el('input', { class: 'input', placeholder: 'e.g. Dr. appointment — Sedona', value: a.title || '' });
  const dateInput = el('input', { class: 'input', type: 'date', value: a.date || todayStr() });
  const who = el('input', { class: 'input', placeholder: 'Who is this for?', value: a.who || '' });
  const location = el('input', { class: 'input', placeholder: 'Location', value: a.location || '' });
  const start = el('input', { class: 'input', type: 'time', value: a.startTime || '' });
  const end = el('input', { class: 'input', type: 'time', value: a.endTime || '' });
  const allDay = el('input', { type: 'checkbox', checked: a.allDay ? 'checked' : null });
  const timesRow = el('div', { class: 'field-row' }, [
    el('div', {}, [el('label', { class: 'field-label' }, 'Start'), start]),
    el('div', {}, [el('label', { class: 'field-label' }, 'End'), end]),
  ]);
  allDay.addEventListener('change', () => {
    timesRow.style.display = allDay.checked ? 'none' : '';
  });
  if (a.allDay) timesRow.style.display = 'none';

  // "Save to" picker — only for brand-new appointments when we can write.
  let saveSel = null;
  if (isNew && isConnected() && canWrite()) {
    let cals = [];
    try { cals = await writableCalendars(); } catch {}
    if (cals.length) {
      const def = getWriteCalendar();
      saveSel = el('select', { class: 'input' }, [
        ...cals.map((c) => el('option', { value: c.id, selected: c.id === def ? 'selected' : null }, c.summary + (c.primary ? ' (primary)' : ''))),
        el('option', { value: '__home__' }, 'Home OS only (not on Google)'),
      ]);
    }
  }

  const actions = [
    !isNew &&
      el('button', {
        class: 'btn btn-danger',
        onclick: async () => {
          await remove('appointments', a.id);
          toast('Appointment deleted');
          m.close();
          onchange?.();
        },
      }, 'Delete'),
    el('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
    el('button', {
      class: 'btn btn-primary',
      onclick: async () => {
        if (!title.value.trim()) return toast('Give it a title', 'warn');
        if (!dateInput.value) return toast('Pick a date', 'warn');
        const fields = {
          title: title.value.trim(),
          date: dateInput.value,
          location: location.value.trim() || null,
          allDay: allDay.checked,
          startTime: allDay.checked ? null : start.value || null,
          endTime: allDay.checked ? null : end.value || null,
        };
        const target = saveSel ? saveSel.value : '__home__';
        if (target !== '__home__') {
          try {
            await createEvent(target, fields);
            setWriteCalendar(target);
            toast('Added to Google Calendar', 'success');
          } catch (err) {
            return toast(err instanceof GcalError ? err.message : 'Could not add to Google Calendar', 'error');
          }
        } else {
          await put('appointments', { ...a, ...fields, who: who.value.trim() || null });
        }
        m.close();
        onchange?.();
      },
    }, isNew ? 'Add appointment' : 'Save'),
  ];

  const m = openModal(isNew ? 'New appointment' : 'Edit appointment', [
    title,
    el('label', { class: 'field-label' }, 'Date'),
    dateInput,
    saveSel ? el('label', { class: 'field-label' }, 'Save to') : null,
    saveSel,
    el('div', { class: 'field-row' }, [
      el('div', {}, [el('label', { class: 'field-label' }, 'Who'), who]),
      el('div', {}, [el('label', { class: 'field-label' }, 'Location'), location]),
    ]),
    el('label', { class: 'check-label' }, [allDay, 'All day']),
    timesRow,
  ], actions);
  title.focus();
}

function segToggle(mode, date) {
  const btn = (m, label) =>
    el('button', {
      class: 'btn seg-btn' + (mode === m ? ' active' : ''),
      onclick: () => navigate(`#/calendar/${m}/${date}`),
    }, label);
  return el('div', { class: 'seg' }, [btn('day', 'Day'), btn('week', 'Week')]);
}

function calNav(title, { onPrev, onNext, showToday, mode, date }) {
  return el('div', { class: 'cal-nav' }, [
    el('button', { class: 'btn', 'aria-label': 'Previous', onclick: onPrev }, '‹'),
    el('span', { class: 'cal-nav-title' }, title),
    showToday
      ? el('button', { class: 'cal-today-chip', onclick: () => navigate(`#/calendar/${mode}/${todayStr()}`) }, 'Today')
      : null,
    el('button', { class: 'btn', 'aria-label': 'Next', onclick: onNext }, '›'),
  ]);
}

export async function renderCalendar(root, { mode = 'day', date = todayStr() } = {}) {
  clear(root);
  root.append(el('div', { class: 'view-head' }, [el('h1', {}, 'Calendar')]), segToggle(mode, date));
  if (!isConnected()) root.append(gcalConnectBar(() => renderCalendar(root, { mode, date })));
  if (mode === 'week') return renderWeek(root, date);
  return renderDay(root, date);
}

async function renderDay(root, date) {
  // Modals mutate data, then redraw the whole view (head + seg included).
  const rerender = preserveScroll(() => renderCalendar(root, { mode: 'day', date }));
  const [chores, appointments] = await Promise.all([
    getAll('chores'),
    appointmentsFor(date, addDays(date, 1)),
  ]);

  const dayChores = chores.filter((c) => c.dueDate === date);
  const dayAppts = appointments
    .filter((a) => a.date === date)
    .sort((a, b) => ((a.allDay ? '' : a.startTime || '') < (b.allDay ? '' : b.startTime || '') ? -1 : 1));

  // Swipe container: fresh node each render, so listeners never pile up or
  // outlive this view (clear(root) drops it, old + new both, automatically).
  const wrap = el('div', { class: 'cal-swipe' });
  onSwipe(wrap, {
    onLeft: () => navigate(`#/calendar/day/${addDays(date, 1)}`), // swipe left → tomorrow
    onRight: () => navigate(`#/calendar/day/${addDays(date, -1)}`), // swipe right → yesterday
  });
  root.append(wrap);
  const append = (...nodes) => wrap.append(...nodes);

  append(
    calNav(fmtDay(date), {
      mode: 'day',
      date,
      showToday: date !== todayStr(),
      onPrev: () => navigate(`#/calendar/day/${addDays(date, -1)}`),
      onNext: () => navigate(`#/calendar/day/${addDays(date, 1)}`),
    }),

    el('div', { class: 'panel-head' }, [
      el('h4', {}, 'Appointments'),
      el('button', { class: 'link', onclick: () => editAppointmentModal(null, date, rerender) }, '+ Appointment'),
    ]),
    el('section', { class: 'panel' },
      dayAppts.length
        ? dayAppts.map((a) =>
            el('div', {
              class: 'event-row' + (a.allDay ? ' all-day' : ''),
              // Live Google events open in Google (read-only here); app
              // appointments open the in-app editor.
              onclick: () =>
                a.source === 'gcal'
                  ? (a.htmlLink ? window.open(a.htmlLink, '_blank', 'noopener') : toast('This is a Google Calendar event', 'info'))
                  : editAppointmentModal(a, date, rerender),
            }, [
              el('span', { class: 'event-time' }, apptTimeLabel(a)),
              el('span', { class: 'event-title' }, [
                a.title,
                a.who ? el('span', { class: 'event-who' }, `· ${a.who}`) : null,
              ]),
            ])
          )
        : [el('p', { class: 'muted small' }, 'No appointments this day.')]
    ),

    el('div', { class: 'panel-head' }, [
      el('h4', {}, 'Tasks due'),
      el('button', { class: 'link', onclick: () => editChoreModal({ dueDate: date }, rerender) }, '+ Task'),
    ]),
    el('section', { class: 'panel' },
      dayChores.length
        ? dayChores.map((c) => choreRow(c, { onchange: rerender, showDue: false }))
        : [el('p', { class: 'muted small' }, 'Nothing due this day.')]
    )
  );
}

async function renderWeek(root, date) {
  // Week starts Monday.
  const d = parseDate(date);
  const monday = new Date(d);
  monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const days = Array.from({ length: 7 }, (_, i) => {
    const day = new Date(monday);
    day.setDate(monday.getDate() + i);
    return dateStr(day);
  });

  const [chores, appointments] = await Promise.all([
    getAll('chores'),
    appointmentsFor(days[0], addDays(days[6], 1)),
  ]);

  const wrap = el('div', { class: 'cal-swipe' });
  onSwipe(wrap, {
    onLeft: () => navigate(`#/calendar/week/${addDays(date, 7)}`), // swipe left → next week
    onRight: () => navigate(`#/calendar/week/${addDays(date, -7)}`), // swipe right → previous week
  });
  root.append(wrap);

  wrap.append(
    calNav(`Week of ${fmtDay(days[0])}`, {
      mode: 'week',
      date,
      showToday: !days.includes(todayStr()),
      onPrev: () => navigate(`#/calendar/week/${addDays(date, -7)}`),
      onNext: () => navigate(`#/calendar/week/${addDays(date, 7)}`),
    })
  );

  const today = todayStr();
  wrap.append(
    el('div', { class: 'week-list' }, days.map((day) => {
      const dayAppts = appointments
        .filter((a) => a.date === day)
        .sort((a, b) => ((a.startTime || '') < (b.startTime || '') ? -1 : 1));
      const dayChores = chores.filter((c) => c.dueDate === day && !c.done);
      const items = [
        ...dayAppts.map((a) => el('span', { class: 'week-item is-event' + (a.allDay ? ' all-day' : '') }, `${a.allDay || !a.startTime ? '' : fmtTime(a.startTime) + ' · '}${a.title}`)),
        ...dayChores.map((c) => el('span', { class: 'week-item' }, `○ ${c.title}`)),
      ];
      const shown = items.slice(0, 6);
      const extra = items.length - shown.length;
      const dd = parseDate(day);
      return el('button', { class: 'week-row' + (day === today ? ' today' : ''), onclick: () => navigate(`#/calendar/day/${day}`) }, [
        el('span', { class: 'week-day' }, [
          el('span', { class: 'week-day-name' }, dd.toLocaleDateString(undefined, { weekday: 'short' })),
          el('span', { class: 'week-day-num' }, dd.getDate()),
        ]),
        el('span', { class: 'week-items' },
          items.length
            ? [...shown, extra > 0 ? el('span', { class: 'week-more' }, `+${extra} more`) : null]
            : [el('span', { class: 'week-item', style: 'color: var(--text-3)' }, '—')]
        ),
      ]);
    }))
  );
}

// calendar.js — day and week views: appointments, chores due, and
// maintenance falling due. Ported from Focus OS. Month view: not in v1.
// Google Calendar read-overlay is planned for v1.5 — keep rendering
// composable so overlay events can slot into these same lists.

import { getAll, put, remove } from './store.js';
import { el, clear, toast, navigate, openModal, todayStr, addDays, parseDate, dateStr, fmtDay } from './ui.js';
import { choreRow, editChoreModal } from './chores.js';
import { getMaintenance, nextDue, maintenanceRow } from './maintenance.js';
import { isConnected, connect, eventsForRange, GcalError } from './gcal.js';

// A "Connect Google Calendar" prompt, shown when not yet connected. Tapping it
// pops Google's read-only consent, then re-renders so live events appear.
function gcalConnectBar(rerender) {
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
        btn.textContent = 'Connect Google Calendar';
      }
    },
  }, 'Connect Google Calendar');
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
  return [...base, ...live];
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

// Create/edit bottom sheet. `preset` seeds fields for contextual creation
// (e.g. a vendor's Schedule button passes title + vendorId).
export function editAppointmentModal(appointment, date, onchange, preset = {}) {
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
        await put('appointments', {
          ...a,
          title: title.value.trim(),
          date: dateInput.value,
          who: who.value.trim() || null,
          location: location.value.trim() || null,
          allDay: allDay.checked,
          startTime: allDay.checked ? null : start.value || null,
          endTime: allDay.checked ? null : end.value || null,
        });
        m.close();
        onchange?.();
      },
    }, isNew ? 'Add appointment' : 'Save'),
  ];

  const m = openModal(isNew ? 'New appointment' : 'Edit appointment', [
    title,
    el('label', { class: 'field-label' }, 'Date'),
    dateInput,
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
  const rerender = () => renderCalendar(root, { mode: 'day', date });
  const [chores, appointments, maintenance, vendors] = await Promise.all([
    getAll('chores'),
    appointmentsFor(date, addDays(date, 1)),
    getMaintenance(),
    getAll('vendors'),
  ]);
  const vendorById = Object.fromEntries(vendors.map((v) => [v.id, v]));

  const dayChores = chores.filter((c) => c.dueDate === date);
  const dayAppts = appointments
    .filter((a) => a.date === date)
    .sort((a, b) => ((a.allDay ? '' : a.startTime || '') < (b.allDay ? '' : b.startTime || '') ? -1 : 1));
  const dayMaint = maintenance.filter((it) => nextDue(it) === date);

  root.append(
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
            el('div', { class: 'event-row', onclick: () => editAppointmentModal(a, date, rerender) }, [
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
      el('h4', {}, 'Chores due'),
      el('button', { class: 'link', onclick: () => editChoreModal({ dueDate: date }, rerender) }, '+ Chore'),
    ]),
    el('section', { class: 'panel' },
      dayChores.length
        ? dayChores.map((c) => choreRow(c, { onchange: rerender, showDue: false, vendorById }))
        : [el('p', { class: 'muted small' }, 'Nothing due this day.')]
    )
  );

  if (dayMaint.length) {
    root.append(
      el('div', { class: 'panel-head' }, [el('h4', {}, 'Upkeep falling due')]),
      el('section', { class: 'panel' }, dayMaint.map((it) => maintenanceRow(it, { onchange: rerender, vendorById })))
    );
  }
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

  root.append(
    calNav(`Week of ${fmtDay(days[0])}`, {
      mode: 'week',
      date,
      showToday: !days.includes(todayStr()),
      onPrev: () => navigate(`#/calendar/week/${addDays(date, -7)}`),
      onNext: () => navigate(`#/calendar/week/${addDays(date, 7)}`),
    })
  );

  const today = todayStr();
  root.append(
    el('div', { class: 'week-list' }, days.map((day) => {
      const dayAppts = appointments
        .filter((a) => a.date === day)
        .sort((a, b) => ((a.startTime || '') < (b.startTime || '') ? -1 : 1));
      const dayChores = chores.filter((c) => c.dueDate === day && !c.done);
      const items = [
        ...dayAppts.map((a) => el('span', { class: 'week-item is-event' }, `${a.allDay || !a.startTime ? '' : fmtTime(a.startTime) + ' · '}${a.title}`)),
        ...dayChores.map((c) => el('span', { class: 'week-item' }, `○ ${c.title}`)),
      ];
      const shown = items.slice(0, 3);
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

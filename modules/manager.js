// manager.js — the House Manager tab. A living weekly plan (shared checklist),
// an on-demand Claude weekly review whose suggestions turn into plan items /
// tasks / appointments / groceries with one tap, and the household's recurring
// maintenance schedule + vendors (the old Upkeep tab, folded in here).

import { getAll, put, remove, now, deviceName, getSettings } from './store.js';
import { el, clear, toast, todayStr, addDays } from './ui.js';
import { getMaintenance, maintenanceRow, editMaintenanceModal } from './maintenance.js';
import { vendorsSection } from './vendors.js';
import { addGroceryItem, STORES } from './grocery.js';
import { reviewWeek, hasApiKey, AIError } from './ai.js';
import { gatherContext, DEFAULT_HOUSEHOLD_NOTES } from './hmcontext.js';

const CHECK_SVG = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

// Turn a suggestion into a real record. `type` decides the store.
export async function applyAdd(type, { title, date, detail, store } = {}, today = todayStr()) {
  if (type === 'appointment') return put('appointments', { title, date: date || today, allDay: true, startTime: null, endTime: null });
  if (type === 'grocery') return addGroceryItem(title, store || STORES[0]);
  if (type === 'plan') return put('plan', { title, detail: detail || null, done: false });
  return put('chores', { title, dueDate: date || null, done: false }); // task
}

// The add buttons for an AI suggestion. `includePlan` adds a "+ Plan" option
// (used in the weekly review, not the daily brief).
export function addButtons(sugg, { today, includePlan = false, onAdded } = {}) {
  const mk = (type, label) => {
    const b = el('button', {
      class: 'btn seg-btn hm-add',
      onclick: async () => {
        b.disabled = 'disabled';
        try {
          await applyAdd(type, { title: sugg.title, date: sugg.date || sugg.day, detail: sugg.detail, store: sugg.store }, today);
          b.textContent = 'Added ✓';
          toast(`Added: ${sugg.title}`, 'success');
          onAdded?.();
        } catch {
          b.disabled = null;
          toast('Could not add that', 'error');
        }
      },
    }, label);
    return b;
  };
  const out = [];
  if (includePlan) out.push(mk('plan', '+ Plan'));
  const t = sugg.suggestedType || sugg.type || 'task';
  if (t === 'appointment') out.push(mk('appointment', '+ Calendar'));
  else if (t === 'grocery') out.push(mk('grocery', '+ Grocery'));
  else if (t === 'task') out.push(mk('task', '+ Task'));
  else if (!includePlan) out.push(mk('task', '+ Task'));
  return el('div', { class: 'hm-actions' }, out);
}

function planRow(p, rerender) {
  return el('div', { class: 'task-row' + (p.done ? ' done' : '') }, [
    el('button', {
      class: 'task-check',
      'aria-label': p.done ? 'Mark not done' : 'Mark done',
      html: p.done ? CHECK_SVG : '',
      onclick: async () => {
        await put('plan', { ...p, done: !p.done, doneAt: !p.done ? now() : null, doneBy: !p.done ? deviceName() : null });
        rerender();
      },
    }),
    el('div', { class: 'task-main' }, [
      el('span', { class: 'task-name' }, p.title),
      (p.detail || p.by) ? el('span', { class: 'task-meta' }, [
        p.detail ? el('span', { class: 'muted small' }, p.detail) : null,
        p.by ? el('span', { class: 'pill' }, p.by) : null,
      ]) : null,
    ]),
    el('button', {
      class: 'link', style: 'padding: 4px 6px; font-size: 15px; line-height: 1', 'aria-label': 'Remove',
      onclick: async () => { await remove('plan', p.id); rerender(); },
    }, '×'),
  ]);
}

export async function renderManager(root) {
  clear(root);
  const rerender = () => renderManager(root);
  const [plan, maintenance, vendors] = await Promise.all([getAll('plan'), getMaintenance(), getAll('vendors')]);
  const vendorById = Object.fromEntries(vendors.map((v) => [v.id, v]));
  const openPlan = plan.filter((p) => !p.done).sort((a, b) => ((a.createdAt || '') < (b.createdAt || '') ? -1 : 1));
  const donePlan = plan.filter((p) => p.done);

  root.append(el('div', { class: 'view-head' }, [el('h1', {}, 'House Manager')]));

  // ----- this week's plan (living checklist) -----
  const planInput = el('input', { class: 'input', placeholder: 'Add a plan item…' });
  async function addPlan() {
    if (!planInput.value.trim()) return;
    await put('plan', { title: planInput.value.trim(), done: false });
    planInput.value = '';
    planInput.focus();
    rerender();
  }
  planInput.addEventListener('keydown', (e) => e.key === 'Enter' && addPlan());
  root.append(
    el('div', { class: 'panel-head' }, [el('h4', {}, `This week's plan (${openPlan.length})`)]),
    el('section', { class: 'panel' }, [
      ...(openPlan.length ? openPlan.map((p) => planRow(p, rerender)) : [el('p', { class: 'muted small' }, 'Nothing planned yet. Add items below, or use the review to build a plan.')]),
      el('div', { class: 'grocery-add', style: 'margin-top: 10px' }, [planInput, el('button', { class: 'btn btn-primary', onclick: addPlan }, 'Add')]),
    ])
  );
  if (donePlan.length) {
    root.append(
      el('h4', { class: 'group-heading' }, `Done this week (${donePlan.length})`),
      el('section', { class: 'panel' }, donePlan.slice(0, 20).map((p) => planRow(p, rerender)))
    );
  }

  // ----- Claude weekly review -----
  const host = el('div', {});
  const reviewBtn = el('button', {
    class: 'btn btn-primary full', style: 'margin-bottom: 6px',
    onclick: async () => {
      if (!hasApiKey()) return toast('Add a Claude API key in Settings', 'warn');
      reviewBtn.disabled = 'disabled';
      reviewBtn.textContent = 'Thinking…';
      clear(host).append(el('div', { class: 'loading' }, [el('div', { class: 'spinner' }), el('span', {}, 'Reviewing the week…')]));
      try {
        const settings = getSettings();
        const ctx = await gatherContext({ start: todayStr(), days: 14 });
        const out = await reviewWeek({
          family: (settings.familyMembers || 'Chris, Kat, Sedona, River').split(',').map((s) => s.trim()).filter(Boolean),
          notes: settings.householdNotes || DEFAULT_HOUSEHOLD_NOTES,
          today: todayStr(),
          events: ctx.eventsText,
          chores: ctx.choresText,
          upkeep: ctx.upkeepText,
          groceries: ctx.groceriesText,
          plan: ctx.planText,
        });
        renderReview(host, out, rerender);
      } catch (err) {
        clear(host).append(el('p', { class: 'muted small' }, err instanceof AIError ? err.message : `Something went wrong: ${err.message}`));
      } finally {
        reviewBtn.disabled = null;
        reviewBtn.textContent = 'Review the week';
      }
    },
  }, 'Review the week');
  root.append(
    el('div', { class: 'panel-head' }, [el('h4', {}, 'Weekly review')]),
    el('section', { class: 'panel' }, [
      el('p', { class: 'muted small', style: 'margin-top:0' }, hasApiKey() ? 'Claude reviews your calendar + lists and proposes a plan for the rest of the week. Add the ones you want with one tap.' : 'Add a Claude API key in Settings to get a weekly plan from Claude.'),
      reviewBtn,
      host,
    ])
  );

  // ----- maintenance schedule (the old Upkeep) -----
  root.append(
    el('div', { class: 'view-head-row', style: 'margin-top: 20px' }, [
      el('h4', { style: 'margin:0' }, 'Maintenance'),
      el('button', { class: 'link', onclick: () => editMaintenanceModal(null, rerender) }, '+ Item'),
    ]),
    el('section', { class: 'panel' },
      maintenance.length
        ? maintenance.map((it) => maintenanceRow(it, { onchange: rerender, vendorById }))
        : [el('p', { class: 'muted small' }, 'Nothing recurring yet. Filters, gutters, smoke-alarm batteries…')]
    ),
    ...(await vendorsSection(rerender))
  );
}

function renderReview(host, out, rerender) {
  clear(host);
  if (out.overview) host.append(el('p', { class: 'hm-overview' }, out.overview));
  for (const item of out.planItems || []) {
    host.append(
      el('div', { class: 'idea' }, [
        el('div', { class: 'idea-title' }, item.title),
        item.detail ? el('p', { class: 'idea-detail' }, item.detail) : null,
        addButtons(item, { today: todayStr(), includePlan: true, onAdded: rerender }),
      ])
    );
  }
  if (out.questions?.length) {
    host.append(
      el('div', { class: 'idea-questions' }, [
        el('h5', {}, 'Claude wants to know'),
        el('ul', { class: 'idea-actions' }, out.questions.map((q) => el('li', {}, q))),
      ])
    );
  }
  if (!out.planItems?.length && !out.questions?.length) host.append(el('p', { class: 'muted small' }, 'Nothing pressing for the rest of the week.'));
}

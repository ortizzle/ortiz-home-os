// manager.js — the Claudia tab: ask her anything, have her plan the week
// (a persistent review whose items add/dismiss with one tap), the family's
// shared weekly checklist, the family meeting, and the recurring maintenance
// schedule + vendors (the old Upkeep tab, folded in here).

import { getAll, put, remove, now, deviceName, getSettings } from './store.js';
import { el, clear, toast, todayStr, addDays, fmtDay, openModal, tableOfContents } from './ui.js';
import { getMaintenance, maintenanceRow, editMaintenanceModal } from './maintenance.js';
import { vendorsSection } from './vendors.js';
import { addGroceryItem, STORES } from './grocery.js';
import { reviewWeek, askManager, hasApiKey, AIError } from './ai.js';
import { gatherContext, DEFAULT_HOUSEHOLD_NOTES, DEFAULT_KIDS, pinToBrief, getReview, saveReview, markReviewAdded, markReviewDismissed, markQuestionResolved, logShownSuggestions, logSuggestionAdded, logSuggestionDismissed, logQuestionResolved, followUpText } from './hmcontext.js';
import { isConnected, canReadEmail } from './gcal.js';
import { meetingSection } from './meeting.js';

const CHECK_SVG = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

// Turn a suggestion into a real record. `type` decides the store.
// Returns { store, rec } so callers can log where the suggestion landed.
export async function applyAdd(type, { title, date, detail, store, who } = {}, today = todayStr()) {
  if (type === 'appointment') return { store: 'appointments', rec: await put('appointments', { title, date: date || today, allDay: true, startTime: null, endTime: null, who: who || null }) };
  if (type === 'grocery') return { store: 'groceries', rec: await addGroceryItem(title, store || STORES[0]) };
  if (type === 'plan') return { store: 'plan', rec: await put('plan', { title, detail: detail || null, done: false }) };
  return { store: 'chores', rec: await put('chores', { title, dueDate: date || null, assignee: who || null, done: false }) }; // task
}

// The add buttons for an AI suggestion. `includePlan` adds a "+ Plan" option
// (used in the weekly review, not the daily brief). `alreadyAdded` renders the
// restored "Added ✓" state when a persisted result is re-rendered.
export function addButtons(sugg, { today, includePlan = false, onAdded, alreadyAdded = false } = {}) {
  if (alreadyAdded) {
    const done = el('button', { class: 'btn seg-btn hm-add' }, 'Added ✓');
    done.disabled = true;
    return el('div', { class: 'hm-actions' }, [done]);
  }
  const mk = (type, label) => {
    const b = el('button', {
      class: 'btn seg-btn hm-add',
      onclick: async () => {
        b.disabled = 'disabled';
        try {
          const { store, rec } = await applyAdd(type, { title: sugg.title, date: sugg.date || sugg.day, detail: sugg.detail, store: sugg.store, who: sugg.who }, today);
          // Feed the follow-through memory: this suggestion was accepted.
          logSuggestionAdded(sugg.title, store, rec?.id).catch(() => {});
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

// The per-render view of the persisted state (now synced — see hmcontext.js
// getReview/saveReview/markReviewAdded/markReviewDismissed/markQuestionResolved,
// shared between both phones like the Home brief).
function reviewState(r) {
  return {
    reviewedAt: r.reviewedAt || null,
    added: new Set(r.added || []),
    dismissed: new Set(r.dismissed || []),
    resolved: r.resolved || {},
  };
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

  root.append(el('div', { class: 'view-head' }, [
    el('h1', {}, 'Claudia'),
    el('p', { class: 'muted' }, 'your house manager'),
  ]));

  // ----- ask Claudia (Q&A over calendar + email + lists) -----
  const askInput = el('input', { class: 'input', placeholder: 'Ask about your week, email, plans…' });
  const askHost = el('div', {});
  const askBtn = el('button', { class: 'btn btn-primary', onclick: runAsk }, 'Ask');
  async function runAsk() {
    const q = askInput.value.trim();
    if (!q) return;
    if (!hasApiKey()) return toast('Add a Claude API key in Settings', 'warn');
    askBtn.disabled = 'disabled';
    askBtn.textContent = 'Thinking…';
    clear(askHost).append(el('div', { class: 'loading' }, [el('div', { class: 'spinner' }), el('span', {}, 'Claudia is looking through your week…')]));
    try {
      const settings = getSettings();
      const ctx = await gatherContext({ start: todayStr(), days: 14, email: true });
      const out = await askManager({
        family: (settings.familyMembers || 'Chris, Kat, Sedona, River').split(',').map((s) => s.trim()).filter(Boolean),
        notes: settings.householdNotes || DEFAULT_HOUSEHOLD_NOTES,
        interests: settings.familyInterests || '',
        today: todayStr(),
        weekday: new Date().toLocaleDateString(undefined, { weekday: 'long' }),
        question: q,
        events: ctx.eventsText,
        email: ctx.emailsText,
        chores: ctx.choresText,
        upkeep: ctx.upkeepText,
        groceries: ctx.groceriesText,
        plan: ctx.planText,
        meals: ctx.mealsText,
      });
      logShownSuggestions(out.suggestions, 'ask').catch(() => {});
      renderAnswer(askHost, out);
    } catch (err) {
      clear(askHost).append(el('p', { class: 'muted small' }, err instanceof AIError ? err.message : `Something went wrong: ${err.message}`));
    } finally {
      askBtn.disabled = null;
      askBtn.textContent = 'Ask';
    }
  }
  askInput.addEventListener('keydown', (e) => e.key === 'Enter' && runAsk());
  const askHint = !hasApiKey()
    ? 'Add a Claude API key in Settings to ask Claudia.'
    : isConnected() && canReadEmail()
      ? 'Ask about your calendar, email, tasks, and plans — then pin any answer to tomorrow’s morning brief.'
      : 'Ask about your calendar, tasks, and plans. Connect Google in Settings (and reconnect to grant email) so she can read recent mail too.';
  root.append(
    el('div', { class: 'panel-head' }, [el('h4', {}, 'Ask Claudia')]),
    el('section', { class: 'panel' }, [
      el('p', { class: 'muted small', style: 'margin-top:0' }, askHint),
      el('div', { class: 'grocery-add' }, [askInput, askBtn]),
      askHost,
    ])
  );

  // ----- plan the week with Claudia (the persistent review, near the top) -----
  const host = el('div', {});
  const reviewBtn = el('button', {
    class: 'btn btn-primary full', style: 'margin-bottom: 6px',
    onclick: async () => {
      if (!hasApiKey()) return toast('Add a Claude API key in Settings', 'warn');
      reviewBtn.disabled = 'disabled';
      reviewBtn.textContent = 'Thinking…';
      clear(host).append(el('div', { class: 'loading' }, [el('div', { class: 'spinner' }), el('span', {}, 'Claudia is reviewing the week & checking what’s on nearby…')]));
      try {
        const settings = getSettings();
        const [ctx, follow] = await Promise.all([
          gatherContext({ start: todayStr(), days: 14 }),
          followUpText(),
        ]);
        const out = await reviewWeek({
          family: (settings.familyMembers || 'Chris, Kat, Sedona, River').split(',').map((s) => s.trim()).filter(Boolean),
          notes: settings.householdNotes || DEFAULT_HOUSEHOLD_NOTES,
          interests: settings.familyInterests || '',
          kids: settings.kidsAges || DEFAULT_KIDS,
          today: todayStr(),
          events: ctx.eventsText,
          chores: ctx.choresText,
          upkeep: ctx.upkeepText,
          groceries: ctx.groceriesText,
          plan: ctx.planText,
          meals: ctx.mealsText,
          follow,
        });
        logShownSuggestions(out.planItems, 'review').catch(() => {});
        await saveReview(out); // persists until the next run, shared with Kat
        renderReview(host, out, rerender, reviewState(await getReview()));
      } catch (err) {
        clear(host).append(el('p', { class: 'muted small' }, err instanceof AIError ? err.message : `Something went wrong: ${err.message}`));
      } finally {
        reviewBtn.disabled = null;
        reviewBtn.textContent = 'Review the week';
      }
    },
  }, 'Review the week');
  // Restore the persisted (shared) review so adds/dismisses — which re-render
  // the view — and even reloads never lose the rest of the list.
  const cachedReview = await getReview();
  if (cachedReview) renderReview(host, cachedReview.data, rerender, reviewState(cachedReview));
  root.append(
    el('div', { class: 'panel-head' }, [el('h4', {}, 'Plan the week with Claudia')]),
    el('section', { class: 'panel' }, [
      el('p', { class: 'muted small', style: 'margin-top:0' }, hasApiKey() ? 'Claudia reviews your calendar + lists, searches for fun things nearby that match your interests, and proposes what to plan. Add what you want with one tap, dismiss (✕) what you don’t — she remembers both. Refresh a couple times a week.' : 'Add a Claude API key in Settings and Claudia will propose what to plan each week.'),
      reviewBtn,
      host,
    ])
  );

  // ----- this week's plan (the shared checklist review items land in) -----
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
      el('p', { class: 'muted small', style: 'margin-top: 0' }, 'The family’s shared checklist — what we’re getting done this week, on both phones. Claudia’s review adds to it; unfinished items carry forward.'),
      ...(openPlan.length ? openPlan.map((p) => planRow(p, rerender)) : [el('p', { class: 'muted small' }, 'Nothing planned yet. Add items below, or have Claudia review the week above.')]),
      el('div', { class: 'grocery-add', style: 'margin-top: 10px' }, [planInput, el('button', { class: 'btn btn-primary', onclick: addPlan }, 'Add')]),
    ])
  );
  if (donePlan.length) {
    root.append(
      el('h4', { class: 'group-heading' }, `Done this week (${donePlan.length})`),
      el('section', { class: 'panel' }, donePlan.slice(0, 20).map((p) => planRow(p, rerender)))
    );
  }

  // ----- family meeting (moved from its own tab) -----
  root.append(...(await meetingSection(rerender)));

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

  // jump-to menu for this long tab
  tableOfContents(root, [
    { label: 'Ask', at: 'Ask Claudia' },
    { label: 'Plan week', at: 'Plan the week' },
    { label: 'Checklist', at: "This week's plan" },
    { label: 'Meeting', at: 'Family meeting' },
    { label: 'Maintenance', at: 'Maintenance' },
  ]);
}

function renderAnswer(host, out) {
  clear(host);
  if (out.answer) host.append(el('p', { class: 'hm-overview' }, out.answer));
  for (const s of out.suggestions || []) {
    host.append(
      el('div', { class: 'idea' }, [
        el('div', { class: 'idea-title' }, s.title),
        s.detail ? el('p', { class: 'idea-detail' }, s.detail) : null,
        // No onAdded re-render: what Ask adds (tasks/calendar/grocery) isn't
        // shown on this screen, and a re-render would wipe the answer.
        addButtons(s, { today: todayStr(), includePlan: false }),
      ])
    );
  }
  // Pin the takeaway to tomorrow's morning brief on the Home tab.
  const noteText = (out.briefNote || out.answer || '').trim();
  if (noteText) {
    const pinBtn = el('button', {
      class: 'btn seg-btn hm-add',
      onclick: async () => {
        await pinToBrief(addDays(todayStr(), 1), noteText);
        pinBtn.disabled = 'disabled';
        pinBtn.textContent = 'Pinned to brief ✓';
        toast('Pinned to tomorrow’s brief — Kat will see it too', 'success');
      },
    }, '📌 Pin to tomorrow’s brief');
    host.append(el('div', { class: 'hm-actions' }, [pinBtn]));
  }
  if (!out.answer) host.append(el('p', { class: 'muted small' }, 'No answer came back — try rephrasing.'));
}

// One review suggestion: add buttons plus a dismiss (✕) that declines it for
// good — Claudia logs it and never suggests it again.
function reviewIdea(item, rerender, state) {
  const actions = addButtons(item, {
    today: todayStr(),
    includePlan: true,
    alreadyAdded: state.added.has(item.title),
    // Record the add BEFORE re-rendering, so the restored (shared) review
    // shows this item as Added ✓ on both phones and keeps the rest on screen.
    onAdded: async () => { await markReviewAdded(item.title); rerender(); },
  });
  if (!state.added.has(item.title)) {
    const dismissBtn = el('button', {
      class: 'btn seg-btn hm-add',
      'aria-label': 'Dismiss — don’t suggest again',
      onclick: async () => {
        await markReviewDismissed(item.title);
        logSuggestionDismissed(item.title).catch(() => {});
        toast('Got it — Claudia won’t suggest that again');
        rerender();
      },
    }, '✕ No thanks');
    actions.append(dismissBtn);
  }
  return el('div', { class: 'idea' }, [
    el('div', { class: 'idea-title' }, [item.title, item.who ? el('span', { class: 'pill pill-accent', style: 'margin-left: 6px' }, item.who) : null]),
    item.detail ? el('p', { class: 'idea-detail' }, item.detail) : null,
    actions,
  ]);
}

// One of Claudia's questions: answer it into her memory, or turn it into a task.
function questionRow(q, rerender, state) {
  const resolved = state.resolved[q];
  if (resolved) {
    return el('li', { class: 'muted' }, [
      `${q} `,
      el('span', { style: 'color: var(--good)' }, typeof resolved === 'string' ? `✓ ${resolved}` : '✓ resolved'),
    ]);
  }
  const taskBtn = el('button', {
    class: 'btn seg-btn hm-add',
    onclick: async () => {
      taskBtn.disabled = 'disabled';
      const { store, rec } = await applyAdd('task', { title: q });
      logSuggestionAdded(q, store, rec?.id).catch(() => {});
      await markQuestionResolved(q, 'turned into a task');
      toast('Added as a task', 'success');
      rerender();
    },
  }, '+ Task');
  const resolveBtn = el('button', {
    class: 'btn seg-btn hm-add',
    onclick: () => {
      const answer = el('input', { class: 'input', placeholder: 'Optional answer Claudia should remember…' });
      const m = openModal('Resolve', [
        el('p', { class: 'muted small', style: 'margin-top: 0' }, q),
        answer,
      ], [
        el('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
        el('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            const a = answer.value.trim();
            await markQuestionResolved(q, a || true);
            logQuestionResolved(q, a).catch(() => {});
            m.close();
            toast(a ? 'Claudia will remember that' : 'Resolved', 'success');
            rerender();
          },
        }, 'Resolve'),
      ]);
      answer.focus();
    },
  }, '✓ Resolve');
  return el('li', {}, [
    el('span', {}, q),
    el('div', { class: 'hm-actions', style: 'margin: 6px 0 2px' }, [taskBtn, resolveBtn]),
  ]);
}

function renderReview(host, out, rerender, state) {
  clear(host);
  if (state.reviewedAt) {
    host.append(el('p', { class: 'muted small', style: 'margin: 0 0 8px' },
      `Reviewed ${state.reviewedAt === todayStr() ? 'today' : fmtDay(state.reviewedAt)} — tap Review the week for a fresh look.`));
  }
  if (out.overview) host.append(el('p', { class: 'hm-overview' }, out.overview));
  const items = (out.planItems || []).filter((item) => !state.dismissed.has(item.title));
  for (const item of items) host.append(reviewIdea(item, rerender, state));
  if (out.questions?.length) {
    host.append(
      el('div', { class: 'idea-questions' }, [
        el('h5', {}, 'Claudia wants to know'),
        el('ul', { class: 'idea-actions' }, out.questions.map((q) => questionRow(q, rerender, state))),
      ])
    );
  }
  if (!items.length && !out.questions?.length) host.append(el('p', { class: 'muted small' }, 'Nothing pressing for the rest of the week.'));
}

// manager.js — the Claudia tab: have her plan the week (a persistent review
// whose items add/dismiss with one tap), the family's shared weekly
// checklist, and the family meeting. Recurring upkeep and vendor contacts
// live as plain Calendar appointments now — no separate maintenance/vendor
// feature.

import { getAll, put, remove, now, deviceName, getSettings } from './store.js';
import { el, clear, toast, todayStr, fmtDay, openModal, tableOfContents, shareText, preserveScroll, disclosure, richText } from './ui.js';
import { addGroceryItem, STORES } from './grocery.js';
import { reviewWeek, claudifyItem, hasApiKey, AIError } from './ai.js';
import { editChoreModal } from './chores.js';
import { gatherContext, DEFAULT_HOUSEHOLD_NOTES, DEFAULT_KIDS, getReview, saveReview, markReviewAdded, markReviewDismissed, markQuestionResolved, markReviewDived, logShownSuggestions, logSuggestionAdded, logQuestionResolved, followUpText } from './hmcontext.js';
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
    // Marks the suggestion accepted once a record actually lands: logs where it
    // went (follow-through memory), flips the button, and re-renders via onAdded.
    const markAdded = (store, rec) => {
      logSuggestionAdded(sugg.title, store, rec?.id).catch(() => {});
      b.textContent = 'Added ✓';
      b.disabled = 'disabled';
      toast(`Added: ${sugg.title}`, 'success');
      onAdded?.();
    };
    const b = el('button', {
      class: 'btn seg-btn hm-add',
      onclick: async () => {
        // A task is the one thing that needs deciding who's on it and by when —
        // so open the task sheet prefilled from the suggestion and let the
        // family confirm assignment + due date before it's saved. Everything
        // else (grocery, calendar, plan) adds in one tap as before.
        if (type === 'task') {
          editChoreModal(
            { title: sugg.title, dueDate: sugg.date || sugg.day || null, assignee: sugg.who || null },
            null,
            { onSaved: (rec) => markAdded('chores', rec) },
          );
          return;
        }
        b.disabled = 'disabled';
        try {
          const { store, rec } = await applyAdd(type, { title: sugg.title, date: sugg.date || sugg.day, detail: sugg.detail, store: sugg.store, who: sugg.who }, today);
          markAdded(store, rec);
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
    dives: r.dives || {},
  };
}

// "Claudify" a plan item: expand it into a fuller, concrete write-up
// (steps, considerations, timeline) shown inline below the row, with a
// Share/Copy button so it can be pasted into email, Notes, Google Docs,
// wherever. Saved on the plan record (p.claudified) so it survives
// rerenders/navigation — it sticks around until re-claudified or the item
// is marked done.
function renderClaudified(resultHost, p, text) {
  clear(resultHost).append(
    el('p', { class: 'idea-detail', style: 'white-space: pre-wrap' }, text),
    el('button', {
      class: 'btn seg-btn hm-add', style: 'margin-top: 6px',
      onclick: () => shareText({ title: p.title, text }),
    }, '📤 Share / copy')
  );
}

// Shared deep-dive runner: gathers the next-2-weeks calendar so the write-up
// fits the family's actual schedule, calls claudifyItem, and renders inline.
// `onText` (optional) persists the result (e.g. onto the plan record).
async function runClaudify({ title, detail = '', kind, resultHost, onText, loadingLabel = 'Claudia is expanding this…' }) {
  if (!hasApiKey()) return toast('Add a Claude API key in Settings', 'warn');
  clear(resultHost).append(el('div', { class: 'loading' }, [el('div', { class: 'spinner' }), el('span', {}, loadingLabel)]));
  try {
    const settings = getSettings();
    const ctx = await gatherContext({ start: todayStr(), days: 14, email: false });
    const text = await claudifyItem({
      family: (settings.familyMembers || 'Chris, Kat, Sedona, River').split(',').map((s) => s.trim()).filter(Boolean),
      notes: settings.householdNotes || DEFAULT_HOUSEHOLD_NOTES,
      events: ctx.eventsText,
      title, detail, kind,
    });
    await onText?.(text);
    return text;
  } catch (err) {
    clear(resultHost).append(el('p', { class: 'muted small' }, err instanceof AIError ? err.message : `Something went wrong: ${err.message}`));
    return null;
  }
}

function claudifyBtn(p, resultHost) {
  return el('button', {
    class: 'link', style: 'padding: 4px 6px; font-size: 13px',
    'aria-label': 'Claudify — expand into a fuller plan',
    onclick: async () => {
      const text = await runClaudify({
        title: p.title, detail: p.detail || '', kind: 'plan', resultHost,
        onText: (t) => put('plan', { ...p, claudified: t }),
      });
      if (text) renderClaudified(resultHost, p, text);
    },
  }, '✨ Claudify');
}

function planRow(p, rerender) {
  const resultHost = el('div', {});
  if (p.claudified && !p.done) renderClaudified(resultHost, p, p.claudified);
  return el('div', { class: 'plan-row-wrap' }, [
    el('div', { class: 'task-row' + (p.done ? ' done' : '') }, [
      el('button', {
        class: 'task-check',
        'aria-label': p.done ? 'Mark not done' : 'Mark done',
        html: p.done ? CHECK_SVG : '',
        onclick: async () => {
          await put('plan', { ...p, done: !p.done, doneAt: !p.done ? now() : null, doneBy: !p.done ? deviceName() : null, claudified: !p.done ? null : p.claudified });
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
      claudifyBtn(p, resultHost),
      el('button', {
        class: 'link', style: 'padding: 4px 6px; font-size: 15px; line-height: 1', 'aria-label': 'Remove',
        onclick: async () => { await remove('plan', p.id); rerender(); },
      }, '×'),
    ]),
    resultHost,
  ]);
}

export async function renderManager(root) {
  clear(root);
  const rerender = preserveScroll(() => renderManager(root));
  let plan = await getAll('plan');
  // Done plan items have an end state: kept ~60 days (doneAt required — a
  // legacy item without a timestamp is kept), then pruned.
  const doneCutoff = new Date(Date.now() - 60 * 86400000).toISOString();
  for (const p of plan.filter((x) => x.done && x.doneAt && x.doneAt < doneCutoff)) {
    await remove('plan', p.id);
    plan = plan.filter((x) => x.id !== p.id);
  }
  const openPlan = plan.filter((p) => !p.done).sort((a, b) => ((a.createdAt || '') < (b.createdAt || '') ? -1 : 1));
  const donePlan = plan.filter((p) => p.done);

  root.append(el('div', { class: 'view-head' }, [
    el('h1', {}, 'Claudia'),
    el('p', { class: 'muted' }, 'your house manager'),
  ]));

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
          gatherContext({ start: todayStr(), days: 14, email: true }),
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
          groceries: ctx.groceriesText,
          plan: ctx.planText,
          meals: ctx.mealsText,
          agenda: ctx.agendaText,
          meetingDecisions: ctx.meetingDecisionsText,
          email: ctx.emailsText,
          follow,
        });
        logShownSuggestions(out.planItems, 'review').catch(() => {});
        await saveReview(out); // persists until the next run, shared with Kat
        renderReview(host, out, rerender, reviewState(await getReview()));
      } catch (err) {
        clear(host).append(el('p', { class: 'muted small' }, err instanceof AIError ? err.message : `Something went wrong: ${err.message}`));
      } finally {
        reviewBtn.disabled = null;
        reviewBtn.textContent = 'Plan the week';
      }
    },
  }, 'Plan the week');
  // Restore the persisted (shared) review so adds/dismisses — which re-render
  // the view — and even reloads never lose the rest of the list.
  const cachedReview = await getReview();
  if (cachedReview) renderReview(host, cachedReview.data, rerender, reviewState(cachedReview));
  root.append(
    el('div', { class: 'panel-head' }, [el('h4', {}, 'Plan the week with Claudia')]),
    el('section', { class: 'panel' }, [
      el('p', { class: 'muted small', style: 'margin-top:0' }, hasApiKey() ? 'Claudia reads your calendar + lists, searches for fun things nearby that match your interests, and proposes what to plan. Add what you want with one tap, clear what you don’t (✓ Not needed). Run it a couple times a week.' : 'Add a Claude API key in Settings and Claudia will propose what to plan each week.'),
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
    // The re-render replaces the whole view (and this input with it) — put
    // focus back on the NEW input so several items can be added in a row.
    await rerender();
    document.querySelector('input[placeholder="Add a plan item…"]')?.focus();
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
    root.append(disclosure(`Done this week (${donePlan.length})`, el('section', { class: 'panel' }, donePlan.slice(0, 20).map((p) => planRow(p, rerender)))));
  }

  // ----- family meeting (moved from its own tab) -----
  root.append(...(await meetingSection(rerender)));

  // jump-to menu for this long tab
  tableOfContents(root, [
    { label: 'Plan week', at: 'Plan the week' },
    { label: 'Checklist', at: "This week's plan" },
    { label: 'Meeting', at: 'Family meeting' },
  ]);
}

// One review suggestion: add buttons plus a clear (✓) that just clears it
// from THIS review — a satisfying checked-off feeling, not a permanent veto.
// Claudia keeps no memory of it, so it's fair game for a future review.
function reviewIdea(item, rerender, state) {
  // Once added, an item is done business — collapse it to a single line
  // (green ✓ + title) so the review stays scannable and space goes to the
  // items still needing a decision. Tap the row to expand the detail back.
  if (state.added.has(item.title)) {
    const wrap = el('div', { class: 'idea idea-added collapsed' }, [
      el('button', {
        class: 'idea-added-head', 'aria-label': `Added: ${item.title} — tap to expand`,
        onclick: () => wrap.classList.toggle('collapsed'),
      }, [
        el('span', { class: 'idea-added-check' }, '✓'),
        el('span', { class: 'idea-added-title' }, item.title),
        item.who ? el('span', { class: 'pill pill-accent' }, item.who) : null,
      ]),
      item.detail ? el('p', { class: 'idea-detail' }, richText(item.detail)) : null,
    ]);
    return wrap;
  }

  const actions = addButtons(item, {
    today: todayStr(),
    includePlan: true,
    alreadyAdded: false,
    // Record the add BEFORE re-rendering, so the restored (shared) review
    // shows this item as Added ✓ on both phones and keeps the rest on screen.
    onAdded: async () => { await markReviewAdded(item.title); rerender(); },
  });
  const clearBtn = el('button', {
    class: 'btn seg-btn hm-add',
    'aria-label': 'Not needed — clear from this review',
    onclick: async () => {
      await markReviewDismissed(item.title);
      toast('Cleared');
      rerender();
    },
  }, '✓ Not needed');
  actions.append(clearBtn);
  // Deep dive: expand the suggestion into a concrete, calendar-aware plan
  // inline — steps, timing, what to have on hand — before deciding to add it.
  // Persisted on the review (synced), so it survives rerenders and shows on
  // both phones until the next review replaces it.
  const diveHost = el('div', {});
  const showDive = (text) => clear(diveHost).append(
    el('p', { class: 'idea-detail', style: 'white-space: pre-wrap; margin-top: 8px' }, text),
    el('button', { class: 'btn seg-btn hm-add', style: 'margin-top: 6px', onclick: () => shareText({ title: item.title, text }) }, '📤 Share / copy'),
  );
  if (state.dives[item.title]) showDive(state.dives[item.title]);
  actions.append(el('button', {
    class: 'btn seg-btn hm-add',
    'aria-label': 'Claudify — deep dive into this suggestion',
    onclick: async () => {
      const text = await runClaudify({
        title: item.title, detail: item.detail || '', kind: 'plan', resultHost: diveHost,
        onText: (t) => markReviewDived(item.title, t),
      });
      if (text) showDive(text);
    },
  }, '✨ Deep dive'));
  return el('div', { class: 'idea' }, [
    el('div', { class: 'idea-title' }, [item.title, item.who ? el('span', { class: 'pill pill-accent', style: 'margin-left: 6px' }, item.who) : null]),
    item.detail ? el('p', { class: 'idea-detail' }, richText(item.detail)) : null,
    actions,
    diveHost,
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
  // Claudify the question itself: instead of just answering or deferring it,
  // have Claudia work it — options, tradeoffs, and a recommendation — so the
  // family decides from an informed position. From there, one tap resolves.
  // The write-up persists on the review (synced), like suggestion dives.
  const diveHost = el('div', {});
  const showDive = (text) => clear(diveHost).append(
    el('p', { class: 'idea-detail', style: 'white-space: pre-wrap; margin-top: 8px' }, text),
    el('div', { class: 'hm-actions', style: 'margin-top: 6px' }, [
      el('button', { class: 'btn seg-btn hm-add', onclick: () => shareText({ title: q, text }) }, '📤 Share / copy'),
      el('button', {
        class: 'btn seg-btn hm-add',
        onclick: async () => {
          // Resolve with her recommendation as the remembered answer.
          await markQuestionResolved(q, text.slice(0, 400));
          logQuestionResolved(q, text.slice(0, 400)).catch(() => {});
          toast('Resolved with Claudia’s recommendation', 'success');
          rerender();
        },
      }, '✓ Resolve with this'),
    ]),
  );
  if (state.dives[q]) showDive(state.dives[q]);
  const claudifyQBtn = el('button', {
    class: 'btn seg-btn hm-add',
    'aria-label': 'Claudify — have Claudia work through this question',
    onclick: async () => {
      const text = await runClaudify({
        title: q, kind: 'question', resultHost: diveHost,
        loadingLabel: 'Claudia is working through the options…',
        onText: (t) => markReviewDived(q, t),
      });
      if (text) showDive(text);
    },
  }, '✨ Claudify');
  return el('li', {}, [
    el('span', {}, richText(q)),
    el('div', { class: 'hm-actions', style: 'margin: 6px 0 2px' }, [claudifyQBtn, taskBtn, resolveBtn]),
    diveHost,
  ]);
}

function renderReview(host, out, rerender, state) {
  clear(host);
  if (state.reviewedAt) {
    host.append(el('p', { class: 'muted small', style: 'margin: 0 0 8px' },
      `Planned ${state.reviewedAt === todayStr() ? 'today' : fmtDay(state.reviewedAt)} — tap Plan the week for a fresh look.`));
  }
  if (out.overview) host.append(el('p', { class: 'hm-overview' }, richText(out.overview)));
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

// manager.js — the Claudia tab: have her plan the week (a persistent review
// whose items add/dismiss with one tap) and the family meeting. Review items
// land directly in Tasks (dateless = "Someday"); the separate weekly-plan
// checklist merged into Tasks in v68. Recurring upkeep and vendor contacts
// live as plain Calendar appointments now — no separate maintenance/vendor
// feature.

import { put, getSettings } from './store.js';
import { el, clear, toast, todayStr, addDays, fmtDay, openModal, tableOfContents, shareText, SHARE_SVG, preserveScroll, richText, plainText } from './ui.js';
import { reviewWeek, adviseQuestion, hasApiKey, AIError } from './ai.js';
import { editChoreModal } from './chores.js';
import { gatherContext, householdKnowledge, upcomingBirthdays, calendarBirthdays, mergeBirthdays, birthdaysText, DEFAULT_KIDS, getReview, saveReview, markReviewAdded, markReviewDismissed, markQuestionResolved, markReviewDived, logShownSuggestions, logSuggestionAdded, logSuggestionDismissed, logQuestionResolved, followUpText } from './hmcontext.js';
import { meetingSection, nextMeetingDates, planningHorizon } from './meeting.js';
import { digestSection } from './digest.js';
import { appointmentsFor } from './calendar.js';

// Turn a suggestion into a real record. `type` decides the store.
// Returns { store, rec } so callers can log where the suggestion landed.
export async function applyAdd(type, { title, date, detail, who } = {}, today = todayStr()) {
  if (type === 'appointment') return { store: 'appointments', rec: await put('appointments', { title, date: date || today, allDay: true, startTime: null, endTime: null, who: who || null }) };
  // 'plan' (pre-v68), 'grocery' (pre-v79 cached reviews — the list feature is
  // gone, so those land as tasks), and 'task' all land in Tasks now.
  return { store: 'chores', rec: await put('chores', { title, dueDate: date || null, assignee: who || null, notes: detail || null, done: false }) };
}

// The add buttons for an AI suggestion. `alreadyAdded` renders the restored
// "Added ✓" state when a persisted result is re-rendered.
export function addButtons(sugg, { today, onAdded, alreadyAdded = false } = {}) {
  if (alreadyAdded) {
    const done = el('button', { class: 'btn seg-btn hm-add' }, 'Added ✓');
    done.disabled = true;
    return el('div', { class: 'hm-actions' }, [done]);
  }
  const mk = (type, label) => {
    // Marks the suggestion accepted once a record actually lands: logs where it
    // went (follow-through memory), flips the button, and re-renders via
    // onAdded — which receives the destination store so the review can record
    // what went where (the finalize summary reads it back).
    const markAdded = (store, rec) => {
      logSuggestionAdded(sugg.title, store, rec?.id).catch(() => {});
      b.textContent = 'Added ✓';
      b.disabled = 'disabled';
      toast(`Added: ${sugg.title}`, 'success');
      onAdded?.(store, rec);
    };
    const b = el('button', {
      class: 'btn seg-btn hm-add',
      onclick: async () => {
        // A task is the one thing that needs deciding who's on it and by when —
        // so open the task sheet prefilled from the suggestion and let the
        // family confirm assignment + due date before it's saved. A calendar
        // add lands in one tap as before.
        if (type === 'task') {
          editChoreModal(
            { title: sugg.title, dueDate: sugg.date || sugg.day || null, assignee: sugg.who || null, notes: sugg.detail || null },
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
  const t = sugg.suggestedType || sugg.type || 'task';
  if (t === 'appointment') out.push(mk('appointment', '+ Calendar'));
  else out.push(mk('task', '+ Task')); // 'task', legacy 'plan'/'grocery', anything else
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
    dest: r.dest || {}, // title -> where it landed (store name / agenda-family / agenda-admin)
  };
}

// How far through the decision queue a review is. total 0 = nothing proposed.
function reviewProgress(out, state) {
  const items = out.planItems || [];
  const qs = out.questions || [];
  return {
    total: items.length + qs.length,
    decided:
      items.filter((i) => state.added.has(i.title) || state.dismissed.has(i.title)).length +
      qs.filter((q) => state.resolved[q]).length,
  };
}

// Route a review item or question onto a meeting agenda: pick Family or Admin,
// and the text lands on that meeting's CURRENT cycle so it shows up in the
// agenda below (and in Claudia's meeting draft). "We should discuss this" is a
// real destination, not a dead end.
async function pickMeeting(text, onRouted) {
  const dates = await nextMeetingDates();
  const go = (type) => el('button', {
    class: 'btn btn-primary',
    onclick: async () => {
      const rec = await put('agenda', { text, reviewed: false, type, cycleDate: dates[type] });
      m.close();
      await onRouted(type, dates[type], rec);
    },
  }, `${type === 'admin' ? 'Admin' : 'Family'} — ${fmtDay(dates[type])}`);
  const m = openModal('Discuss at which meeting?', [
    el('p', { class: 'muted small', style: 'margin-top: 0' }, text),
  ], [
    el('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
    go('family'),
    go('admin'),
  ]);
}

// Deep link to the Claudia tab of the deployed app (same idea as the Tasks
// share link in chores.js).
const APP_CLAUDIA_URL = 'https://ortizzle.github.io/ortiz-home-os/#/manager';

// A plain-text, WhatsApp-friendly version of the current weekly plan + link.
// Dismissed ideas and resolved questions are decided business, so they're
// dropped; added ideas stay, marked ✓, since the plan includes what's landed.
function reviewShareText(out, state) {
  const lines = [`🏡 Claudia's weekly plan${state.reviewedAt ? ` — planned ${fmtDay(state.reviewedAt)}` : ''}`, ''];
  if (out.overview) lines.push(plainText(out.overview), '');
  const items = (out.planItems || []).filter((i) => !state.dismissed.has(i.title));
  if (items.length) {
    lines.push('💡 Ideas');
    for (const i of items) {
      lines.push(`${state.added.has(i.title) ? '✓' : '•'} ${i.title}${i.who ? ` (${i.who})` : ''}`);
      if (i.detail) lines.push(`  ${plainText(i.detail)}`);
    }
    lines.push('');
  }
  const open = (out.questions || []).filter((q) => !state.resolved[q]);
  if (open.length) {
    lines.push('❓ Claudia wants to know');
    for (const q of open) lines.push(`• ${plainText(q)}`);
    lines.push('');
  }
  lines.push(`Open in the app: ${APP_CLAUDIA_URL}`);
  return lines.join('\n').trim();
}

// Decision-aid runner for one of Claudia's open questions: gathers the
// next-2-weeks calendar so the advice fits the actual schedule, calls
// adviseQuestion, and renders inline. `onText` persists the write-up onto
// the review. (v68: the universal deep dive is gone — tasks break down into
// subtasks from the task sheet instead; questions are where a write-up
// still earns its cost.)
async function runAdvise({ title, resultHost, onText }) {
  if (!hasApiKey()) return toast('Add a Claude API key in Settings', 'warn');
  clear(resultHost).append(el('div', { class: 'loading' }, [el('div', { class: 'spinner' }), el('span', {}, 'Claudia is working through the options…')]));
  try {
    const settings = getSettings();
    const ctx = await gatherContext({ start: todayStr(), days: 14, email: false });
    const text = await adviseQuestion({
      family: (settings.familyMembers || 'Chris, Kat, Sedona, River').split(',').map((s) => s.trim()).filter(Boolean),
      notes: await householdKnowledge(settings),
      events: ctx.eventsText,
      title,
    });
    await onText?.(text);
    return text;
  } catch (err) {
    clear(resultHost).append(el('p', { class: 'muted small' }, err instanceof AIError ? err.message : `Something went wrong: ${err.message}`));
    return null;
  }
}

export async function renderManager(root) {
  clear(root);
  const rerender = preserveScroll(() => renderManager(root));

  root.append(el('div', { class: 'view-head' }, [
    el('h1', {}, 'Claudia'),
    el('p', { class: 'muted' }, 'your house manager'),
  ]));

  // ----- the digest: computed facts first, so the state of the stretch is
  // visible instantly and for free; Claudia's AI review below interprets it.
  // Collapsed by default — a quick-reference panel, not the first thing to
  // read on every visit; tap to expand when you actually want it. -----
  const cachedReview = await getReview();
  const digestEl = await digestSection();
  root.append(digestEl);

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
        const today = todayStr();
        // Plan through the next family meeting (≥7 days out) — the same
        // horizon the digest shows, so Claudia reads what the family sees.
        const { throughDate, windowDays } = await planningHorizon(today);
        // Filter bygone 'learned' facts out of the memory block (keep-memory,
        // filter-the-prompt), then compute upcoming birthdays from what's left
        // so Claudia gets them as explicit dated lines, not date math to do.
        // Birthday-titled calendar events merge in too (deduped), so a
        // birthday that lives only on the calendar still gets gift lead time.
        const notes = await householdKnowledge(settings, { today });
        const [ctx, follow, bdayAppts] = await Promise.all([
          gatherContext({ start: today, days: windowDays, email: true }),
          followUpText(),
          appointmentsFor(today, addDays(today, 36)).catch(() => []),
        ]);
        const birthdays = birthdaysText(mergeBirthdays(
          upcomingBirthdays(notes, today, 35),
          calendarBirthdays(bdayAppts, today, 35)
        ));
        const out = await reviewWeek({
          family: (settings.familyMembers || 'Chris, Kat, Sedona, River').split(',').map((s) => s.trim()).filter(Boolean),
          notes,
          birthdays,
          interests: settings.familyInterests || '',
          kids: settings.kidsAges || DEFAULT_KIDS,
          today,
          throughDate,
          events: ctx.eventsText,
          chores: ctx.choresText,
          agenda: ctx.agendaText,
          meetingDecisions: ctx.meetingDecisionsText,
          email: ctx.emailsText,
          follow,
          school: ctx.schoolText,
        });
        logShownSuggestions(out.planItems, 'review').catch(() => {});
        await saveReview(out); // persists until the next run, shared with Kat
        // A fresh queue is now the work — tuck the digest away immediately
        // (the next full render keeps it collapsed while items are undecided).
        if ((out.planItems || []).length || (out.questions || []).length) digestEl.removeAttribute('open');
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
  // (cachedReview was fetched above, alongside the digest.)
  if (cachedReview) renderReview(host, cachedReview.data, rerender, reviewState(cachedReview));
  // Fetches the review at tap time (not render time), so it shares whatever
  // is current even if a fresh plan landed after this header was built.
  const shareReview = el('button', {
    class: 'icon-btn',
    'aria-label': 'Share the weekly plan',
    title: 'Share the weekly plan',
    html: SHARE_SVG,
    onclick: async () => {
      const r = await getReview();
      if (!r?.data) return toast('No weekly plan to share yet — tap Plan the week first', 'warn');
      shareText({ title: "Claudia's weekly plan", text: reviewShareText(r.data, reviewState(r)) });
    },
  });
  root.append(
    el('div', { class: 'panel-head' }, [
      el('h4', {}, '1. Plan the week'),
      cachedReview || hasApiKey() ? shareReview : null,
    ]),
    el('section', { class: 'panel' }, [
      el('p', { class: 'muted small', style: 'margin-top:0' }, hasApiKey() ? 'Claudia reads the digest above (plus your interests and recent email) and proposes what to plan. Decide every item: add it with one tap, send it to a meeting (→ Meeting), or clear it (✓ Not needed) — anything routed to a meeting is waiting in Step 2 below, ready to organize into an agenda.' : 'Add a Claude API key in Settings and Claudia will propose what to plan each week.'),
      reviewBtn,
      host,
    ])
  );

  // ----- family meeting (moved from its own tab; step 2 of the flow above:
  // organizes whatever landed here — typed directly, or routed via → Meeting) -----
  root.append(...(await meetingSection(rerender)));

  // jump-to menu for this long tab
  tableOfContents(root, [
    { label: 'Digest', at: 'The stretch ahead' },
    { label: 'Plan week', at: '1. Plan the week' },
    { label: 'Meeting', at: "2. This week's meeting" },
  ]);
}

// One review suggestion: add buttons plus a clear (✓) that clears it from
// this review AND logs the dismissal, so Claudia stops re-suggesting it for
// a few weeks — not a permanent veto (the log entry prunes away).
function reviewIdea(item, rerender, state) {
  // Once added, an item is done business — collapse it to a single line
  // (green ✓ + title) so the review stays scannable and space goes to the
  // items still needing a decision. Tap the row to expand the detail back.
  if (state.added.has(item.title)) {
    // Where it landed — meeting-routed items say so, since "on the agenda"
    // is a different promise than "it's a task now".
    const dest = state.dest?.[item.title];
    const destLabel = dest === 'agenda-family' ? 'family meeting' : dest === 'agenda-admin' ? 'admin meeting' : null;
    const wrap = el('div', { class: 'idea idea-added collapsed' }, [
      el('button', {
        class: 'idea-added-head', 'aria-label': `Added: ${item.title} — tap to expand`,
        onclick: () => wrap.classList.toggle('collapsed'),
      }, [
        el('span', { class: 'idea-added-check' }, destLabel ? '→' : '✓'),
        el('span', { class: 'idea-added-title' }, item.title),
        destLabel ? el('span', { class: 'pill' }, destLabel) : null,
        item.who ? el('span', { class: 'pill pill-accent' }, item.who) : null,
      ]),
      item.detail ? el('p', { class: 'idea-detail' }, richText(item.detail)) : null,
    ]);
    return wrap;
  }

  const actions = addButtons(item, {
    today: todayStr(),
    alreadyAdded: false,
    // Record the add (and where it went) BEFORE re-rendering, so the restored
    // (shared) review shows this item as Added ✓ on both phones and the
    // finalize summary can say what landed where.
    onAdded: async (store) => { await markReviewAdded(item.title, store); rerender(); },
  });
  // "We should discuss this" is a destination too — route the item onto the
  // Family or Admin agenda's current cycle, where the meeting section picks
  // it up for the final family review.
  actions.append(el('button', {
    class: 'btn seg-btn hm-add',
    'aria-label': 'Queue for a meeting agenda',
    onclick: () => pickMeeting(item.title, async (type, date, rec) => {
      logSuggestionAdded(item.title, 'agenda', rec?.id).catch(() => {});
      await markReviewAdded(item.title, `agenda-${type}`);
      toast(`On the ${type} meeting agenda (${fmtDay(date)})`, 'success');
      rerender();
    }),
  }, '→ Meeting'));
  const clearBtn = el('button', {
    class: 'btn seg-btn hm-add',
    'aria-label': 'Not needed — clear from this review',
    onclick: async () => {
      await markReviewDismissed(item.title);
      logSuggestionDismissed(item.title).catch(() => {});
      toast('Cleared');
      rerender();
    },
  }, '✓ Not needed');
  actions.append(clearBtn);
  // (v68: no per-suggestion deep dive — add it as a task, then break it into
  // subtasks from the task sheet if it needs steps.)
  return el('div', { class: 'idea' }, [
    el('div', { class: 'idea-title' }, [item.title, item.who ? el('span', { class: 'pill pill-accent', style: 'margin-left: 6px' }, item.who) : null]),
    item.detail ? el('p', { class: 'idea-detail' }, richText(item.detail)) : null,
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
  // A question the family should settle together goes on a meeting agenda —
  // resolved here (so the review moves on) with a note saying where it went.
  const meetBtn = el('button', {
    class: 'btn seg-btn hm-add',
    'aria-label': 'Discuss at a meeting',
    onclick: () => pickMeeting(q, async (type, date) => {
      await markQuestionResolved(q, `to discuss at the ${type} meeting (${fmtDay(date)})`);
      logQuestionResolved(q, `queued for the ${type} meeting`).catch(() => {});
      toast(`On the ${type} meeting agenda (${fmtDay(date)})`, 'success');
      rerender();
    }),
  }, '→ Meeting');
  const resolveBtn = el('button', {
    class: 'btn seg-btn hm-add',
    onclick: () => {
      const answer = el('input', { class: 'input', placeholder: 'Optional answer…' });
      // Off by default: resolving just settles the question for this week's
      // plan. Tick this only for answers worth keeping for the long run — they
      // become a standing fact Claudia reads in every brief, review, and plan.
      const remember = el('input', { type: 'checkbox' });
      const rememberRow = el('label', { class: 'carry-row', style: 'margin-top: 8px' }, [
        remember,
        el('span', { class: 'carry-text' }, 'Remember this for Claudia (keeps it for future planning)'),
      ]);
      const m = openModal('Resolve', [
        el('p', { class: 'muted small', style: 'margin-top: 0' }, q),
        answer,
        rememberRow,
      ], [
        el('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
        el('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            const a = answer.value.trim();
            await markQuestionResolved(q, a || true);
            logQuestionResolved(q, a, { remember: remember.checked }).catch(() => {});
            m.close();
            toast(a ? (remember.checked ? 'Resolved — Claudia will remember that' : 'Resolved') : 'Resolved', 'success');
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
          // Resolve with her recommendation as the answer — kept on the review
          // and in the follow-through log, but not promoted to standing memory
          // (that's the opt-in "Remember this" on the Resolve dialog).
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
      const text = await runAdvise({
        title: q, resultHost: diveHost,
        onText: (t) => markReviewDived(q, t),
      });
      if (text) showDive(text);
    },
  }, '✨ Claudify');
  return el('li', {}, [
    el('span', {}, richText(q)),
    el('div', { class: 'hm-actions', style: 'margin: 6px 0 2px' }, [claudifyQBtn, taskBtn, meetBtn, resolveBtn]),
    diveHost,
  ]);
}

// Human labels for the destinations the finalize summary reports.
const DEST_LABELS = {
  chores: 'tasks', appointments: 'calendar', plan: 'weekly plan', groceries: 'grocery list' /* legacy suggLog entries */,
  'agenda-family': 'family meeting', 'agenda-admin': 'admin meeting',
};

// The pre-read: what this review decided and where everything went — shared
// as the meeting's summary once the queue is done.
function finalizeShareText(out, state) {
  const lines = [`🏡 Claudia's review — decided ${fmtDay(state.reviewedAt || todayStr())}`, ''];
  if (out.overview) lines.push(plainText(out.overview), '');
  const byDest = {};
  for (const t of state.added) (byDest[state.dest[t] || 'added'] ||= []).push(t);
  for (const [dest, titles] of Object.entries(byDest)) {
    lines.push(`${DEST_LABELS[dest] ? `→ ${DEST_LABELS[dest][0].toUpperCase()}${DEST_LABELS[dest].slice(1)}` : 'Added'}:`);
    for (const t of titles) lines.push(`  ✓ ${t}`);
  }
  if (state.dismissed.size) lines.push(`Cleared (not needed): ${[...state.dismissed].join(' · ')}`);
  const answered = Object.entries(state.resolved);
  if (answered.length) {
    lines.push('', 'Questions settled:');
    for (const [q, a] of answered) lines.push(`  • ${q}${typeof a === 'string' ? ` — ${a}` : ''}`);
  }
  lines.push('', `Open in the app: ${APP_CLAUDIA_URL}`);
  return lines.join('\n').trim();
}

// Every item decided → the review is finished business: summarize what went
// where, hand over the shareable pre-read, and point at the seeded agenda.
function finalizeBar(out, state) {
  const counts = {};
  for (const t of state.added) counts[state.dest[t] || 'added'] = (counts[state.dest[t] || 'added'] || 0) + 1;
  const parts = Object.entries(counts).map(([d, n]) => `${n} → ${DEST_LABELS[d] || 'added'}`);
  if (state.dismissed.size) parts.push(`${state.dismissed.size} cleared`);
  const answered = Object.keys(state.resolved).length;
  if (answered) parts.push(`${answered} question${answered === 1 ? '' : 's'} settled`);
  const toMeeting = [...state.added].some((t) => (state.dest[t] || '').startsWith('agenda'));
  return el('div', { class: 'idea', style: 'border-left: 3px solid var(--good)' }, [
    el('div', { class: 'idea-title' }, '✅ Review complete'),
    el('p', { class: 'idea-detail' }, parts.length ? parts.join(' · ') : 'Nothing needed action this time.'),
    toMeeting ? el('p', { class: 'idea-detail' }, 'Routed topics are on the meeting agenda below, ready for the family review.') : null,
    el('div', { class: 'hm-actions' }, [
      el('button', {
        class: 'btn seg-btn hm-add',
        onclick: () => shareText({ title: "Claudia's review — pre-read", text: finalizeShareText(out, state) }),
      }, '📤 Share the pre-read'),
    ]),
  ]);
}

function renderReview(host, out, rerender, state) {
  clear(host);
  if (state.reviewedAt) {
    host.append(el('p', { class: 'muted small', style: 'margin: 0 0 8px' },
      `Planned ${state.reviewedAt === todayStr() ? 'today' : fmtDay(state.reviewedAt)} — tap Plan the week for a fresh look.`));
  }
  if (out.overview) host.append(el('p', { class: 'hm-overview' }, richText(out.overview)));
  // The decision queue: every item and question ends somewhere, and the
  // review is done when the count hits zero — that's what makes this
  // execution, not reading.
  const allItems = out.planItems || [];
  const allQs = out.questions || [];
  const { total, decided } = reviewProgress(out, state);
  if (total) {
    host.append(el('p', { class: 'muted small', style: 'margin: 0 0 8px' },
      decided === total ? `All ${total} decided.` : `Decided ${decided} of ${total} — each item needs a destination (or ✓ Not needed).`));
  }
  if (total && decided === total) host.append(finalizeBar(out, state));
  const items = allItems.filter((item) => !state.dismissed.has(item.title));
  for (const item of items) host.append(reviewIdea(item, rerender, state));
  if (allQs.length) {
    host.append(
      el('div', { class: 'idea-questions' }, [
        el('h5', {}, 'Claudia wants to know'),
        el('ul', { class: 'idea-actions' }, allQs.map((q) => questionRow(q, rerender, state))),
      ])
    );
  }
  if (!items.length && !allQs.length) host.append(el('p', { class: 'muted small' }, 'Nothing pressing for the rest of the week.'));
}

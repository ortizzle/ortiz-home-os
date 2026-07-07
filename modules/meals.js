// meals.js — the week's dinners. Lives on the Grocery tab (meals drive the
// shopping list): a 7-night view, tap-to-edit, and "Plan dinners with
// Claudia" which fits meals to each evening's calendar and pushes missing
// ingredients onto the grocery list.

import { getAll, put, remove, getSettings } from './store.js';
import { el, clear, toast, todayStr, addDays, fmtDay, openModal, parseDate } from './ui.js';
import { planMeals, hasApiKey, AIError } from './ai.js';
import { gatherContext, DEFAULT_FOOD_NOTES, DEFAULT_KIDS } from './hmcontext.js';
import { addGroceryItem } from './grocery.js';

// One row per night for the next 7 days: planned meal or a tap-to-add slot.
export function dinnersSection(meals, rerender) {
  const today = todayStr();
  const mealByDate = {};
  for (const m of meals) mealByDate[m.date] = m; // one dinner per night
  const nights = Array.from({ length: 7 }, (_, i) => addDays(today, i));

  const rows = nights.map((date) => {
    const m = mealByDate[date];
    const dayLabel = date === today ? 'Tonight' : parseDate(date).toLocaleDateString(undefined, { weekday: 'short' });
    return el('div', { class: 'event-row', onclick: () => editMealModal(m || null, date, rerender) }, [
      el('span', { class: 'event-time' }, dayLabel),
      m
        ? el('span', { class: 'event-title' }, [m.title, m.by ? el('span', { class: 'event-who' }, `· ${m.by}`) : null])
        : el('span', { class: 'event-title muted' }, '+ plan dinner'),
    ]);
  });

  // Claudia: fill the empty nights.
  const host = el('div', {});
  const planBtn = el('button', {
    class: 'btn btn-primary full', style: 'margin-top: 10px',
    onclick: async () => {
      if (!hasApiKey()) return toast('Add a Claude API key in Settings', 'warn');
      planBtn.disabled = 'disabled';
      planBtn.textContent = 'Planning…';
      clear(host).append(el('div', { class: 'loading' }, [el('div', { class: 'spinner' }), el('span', {}, 'Claudia is planning dinners around your week…')]));
      try {
        const settings = getSettings();
        const ctx = await gatherContext({ start: today, days: 7 });
        const out = await planMeals({
          family: (settings.familyMembers || 'Chris, Kat, Sedona, River').split(',').map((s) => s.trim()).filter(Boolean),
          foodNotes: settings.foodNotes || DEFAULT_FOOD_NOTES,
          kids: settings.kidsAges || DEFAULT_KIDS,
          today,
          events: ctx.eventsText,
          existingMeals: ctx.mealsText,
          groceries: ctx.groceriesText,
        });
        renderMealPlan(host, out, mealByDate, rerender);
      } catch (err) {
        clear(host).append(el('p', { class: 'muted small' }, err instanceof AIError ? err.message : `Something went wrong: ${err.message}`));
      } finally {
        planBtn.disabled = null;
        planBtn.textContent = 'Plan dinners with Claudia';
      }
    },
  }, 'Plan dinners with Claudia');

  return [
    el('div', { class: 'panel-head' }, [el('h4', {}, "This week's dinners")]),
    el('section', { class: 'panel' }, [...rows, hasApiKey() ? planBtn : null, host]),
  ];
}

// Proposed dinners: each adds to its night with one tap, and its ingredients
// (minus what's already on the list) can be pushed to grocery with another.
function renderMealPlan(host, out, mealByDate, rerender) {
  clear(host);
  if (out.note) host.append(el('p', { class: 'hm-overview', style: 'margin-top: 10px' }, out.note));
  const proposals = (out.meals || []).filter((m) => m.date && m.title && !mealByDate[m.date]);
  for (const m of proposals) {
    const addBtn = el('button', {
      class: 'btn seg-btn hm-add',
      onclick: async () => {
        addBtn.disabled = 'disabled';
        await put('meals', { date: m.date, title: m.title, detail: m.detail || null, ingredients: m.ingredients || [] });
        addBtn.textContent = 'Added ✓';
        toast(`${fmtDay(m.date)}: ${m.title}`, 'success');
      },
    }, '+ Add');
    const grocBtn = (m.ingredients || []).length
      ? el('button', {
          class: 'btn seg-btn hm-add',
          onclick: async () => {
            grocBtn.disabled = 'disabled';
            const existing = new Set((await getAll('groceries')).filter((g) => !g.gotAt).map((g) => g.name.toLowerCase()));
            let added = 0;
            for (const ing of m.ingredients) {
              if (!existing.has(ing.toLowerCase())) { await addGroceryItem(ing); added++; }
            }
            grocBtn.textContent = added ? `${added} to grocery ✓` : 'All on the list ✓';
          },
        }, '+ Groceries')
      : null;
    host.append(
      el('div', { class: 'idea' }, [
        el('div', { class: 'idea-title' }, `${fmtDay(m.date)} — ${m.title}`),
        m.detail ? el('p', { class: 'idea-detail' }, m.detail) : null,
        (m.ingredients || []).length ? el('p', { class: 'idea-detail' }, `Needs: ${m.ingredients.join(', ')}`) : null,
        el('div', { class: 'hm-actions' }, [addBtn, grocBtn]),
      ])
    );
  }
  if (!proposals.length) host.append(el('p', { class: 'muted small', style: 'margin-top: 10px' }, 'Every night already has a dinner planned. Nice.'));
  else host.append(el('div', { class: 'hm-actions', style: 'margin-top: 4px' }, [
    el('button', { class: 'btn seg-btn', onclick: rerender }, 'Done — refresh the week'),
  ]));
}

// Add/edit a single night's dinner.
function editMealModal(meal, date, rerender) {
  const title = el('input', { class: 'input', placeholder: "e.g. Sheet-pan chicken & broccoli", value: meal?.title || '' });
  const detail = el('textarea', { class: 'input', rows: 3, placeholder: 'Recipe notes (optional)' }, meal?.detail || '');
  const m = openModal(`Dinner — ${fmtDay(date)}`, [
    el('div', {}, [el('label', { class: 'field-label' }, 'What are we making?'), title]),
    el('div', {}, [el('label', { class: 'field-label' }, 'Notes'), detail]),
  ], [
    meal ? el('button', { class: 'btn', onclick: async () => { await remove('meals', meal.id); m.close(); rerender(); } }, 'Remove') : null,
    el('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
    el('button', {
      class: 'btn btn-primary',
      onclick: async () => {
        const t = title.value.trim();
        if (!t) return toast('Give it a name', 'warn');
        await put('meals', { ...(meal || {}), date, title: t, detail: detail.value.trim() || null });
        m.close();
        rerender();
      },
    }, 'Save'),
  ]);
  title.focus();
}

// ai.js — Claude API wrapper for the family-meeting advisor. Everything
// funnels through callClaude() so the transport (direct browser call today)
// can be swapped for a proxy later with zero changes to callers.
//
// Model: claude-sonnet-5 — the balanced Claude 5, near-Opus quality at a few
// cents per weekly review. NOTE: Sonnet 5 rejects non-default
// `temperature`/`top_p`/`budget_tokens` with a 400 (don't add them — this is
// why we don't copy Learning OS's ai.js, which targets Sonnet 4.6 and sets
// temperature). Thinking is adaptive-by-default on Sonnet 5; we send
// `thinking: {type: "disabled"}` so the full token budget goes to the JSON
// answer instead of being spent on (and truncated by) thinking blocks.

import { getSettings } from './store.js';

const MODEL = 'claude-sonnet-5';
const API_URL = 'https://api.anthropic.com/v1/messages';

export class AIError extends Error {}

export function hasApiKey() {
  return Boolean(getSettings().apiKey);
}

// Anthropic's server-side web search tool. Lets the weekly review and the
// Ask box find real, current things — movie showtimes, local events — instead
// of guessing. Searches run on Anthropic's side (~1¢ each); max_uses caps cost.
function webSearchTool() {
  const city = (getSettings().homeCity || '').trim();
  const t = { type: 'web_search_20250305', name: 'web_search', max_uses: 3 };
  t.user_location = { type: 'approximate', timezone: 'America/Phoenix', country: 'US', ...(city ? { city } : {}) };
  return t;
}

// The single transport seam. To move to a proxy later, change only this fn.
// When `tools` includes web search, the API may pause mid-turn between
// searches (stop_reason 'pause_turn') — we loop, feeding the partial turn
// back, until Claude finishes.
async function callClaude({ system, messages, maxTokens = 2048, tools }) {
  const { apiKey } = getSettings();
  if (!apiKey) {
    throw new AIError('No Claude API key set. Add one in Settings.');
  }

  let convo = messages;
  for (let hop = 0; hop < 5; hop++) {
    const body = { model: MODEL, max_tokens: maxTokens, messages: convo, thinking: { type: 'disabled' } };
    if (system) body.system = system;
    if (tools?.length) body.tools = tools;

    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          // Required for direct browser access. Remove when moving to a proxy.
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new AIError(`Network error reaching Claude: ${err.message}`);
    }

    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.json())?.error?.message || '';
      } catch {
        /* ignore */
      }
      throw new AIError(`Claude API ${res.status}: ${detail || res.statusText}`);
    }

    const json = await res.json();
    if (json.stop_reason === 'pause_turn') {
      convo = [...convo, { role: 'assistant', content: json.content }];
      continue;
    }
    return (json.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
  }
  throw new AIError('Claude paused too many times — try again.');
}

// Strip accidental markdown fences before JSON.parse.
function stripFences(text) {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

// Parse the JSON out of a response. Web-searching turns sometimes wrap the
// JSON in a sentence, so fall back to the outermost {...} before giving up.
function parseJSON(raw) {
  const text = stripFences(raw);
  try {
    return JSON.parse(text);
  } catch {
    const a = text.indexOf('{');
    const b = text.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(text.slice(a, b + 1));
    throw new SyntaxError('No JSON object found');
  }
}

async function generateJSON({ system, prompt, maxTokens, tools }) {
  const attempt = async (extra) => {
    const raw = await callClaude({
      system,
      maxTokens,
      tools,
      messages: [{ role: 'user', content: prompt + (extra || '') }],
    });
    return parseJSON(raw);
  };
  try {
    return await attempt('');
  } catch (err) {
    if (err instanceof AIError) throw err;
    // Parse failure — retry once, reminding it to return raw JSON only.
    return attempt('\n\nIMPORTANT: Respond with valid JSON only. No prose, no markdown fences.');
  }
}

// ---------- Family meeting advisor ----------

// Drafts a full family-meeting plan from the week — a proposed agenda drawn
// from real events and open items, plus fun icebreakers and togetherness
// activities that get everyone (including the kids) participating.
// `type`: 'family' (Wednesday-style, kids included — warm, icebreakers,
// togetherness activities) or 'admin' (Chris + Kat only — brisk, household
// ops/projects/finances, no kid content).
export async function draftMeeting({ attendees = [], notes = '', meetingDate, when = '', weekAhead = '', openItems = '', currentAgenda = '', stillOpen = '', type = 'family' } = {}) {
  const system = (type === 'admin'
    ? `You are Claudia, the Ortiz house manager, helping ${attendees.join(' and ') || 'Chris and Kat'} run a quick admin meeting — just the two of them, no kids. Draft an agenda drawn from real open household items: tasks, the weekly plan, projects, decisions, budgeting — never invent anything not in the data. Focus tightly on core household items — brisk and businesslike, like a well-run status check between two people running a household together, not a family gathering. No icebreakers or kid activities. Respond with JSON only — no markdown, no fences.`
    : `You are Claudia, the Ortiz family's AI house manager, helping them run a warm, fun weekly family meeting. Family: ${attendees.join(', ') || 'the family'} (Sedona and River are kids). Draft an agenda drawn from the week's real events and open items — never invent events, people, or commitments. Make it feel like a family moment, not a status meeting: consider icebreakers and connections to fun family activities or memories, so it feels nostalgic and togetherness-building, not a checklist. Keep everything concrete and kid-friendly. Respond with JSON only — no markdown, no fences.`)
    + ' FOLLOW-THROUGH: some topics from last meeting were never checked off — genuinely fold in the ones that still matter (it\'s fine to drop something that clearly resolved itself), so nothing quietly falls through the cracks.';

  const prompt = `Draft this week's ${type === 'admin' ? 'admin' : 'family'} meeting${meetingDate ? ` for ${meetingDate}` : ''}${when ? `, ${when}` : ''}.

HOUSEHOLD NOTES / PREFERENCES:
${notes || '(none)'}

THE WEEK AHEAD (real calendar + household):
${weekAhead || '(nothing logged)'}

OPEN ITEMS FROM DURING THE WEEK (tasks, plans worth raising):
${openItems || '(none)'}

STILL OPEN FROM LAST MEETING (never checked off — follow up on what still matters):
${stillOpen || '(nothing carried over)'}

ALREADY ON THE AGENDA (do not repeat):
${currentAgenda || '(nothing yet)'}

Return JSON with exactly this shape:
{
  "draftAgenda": [ { "topic": "short agenda topic", "why": "one line: why it's worth 2 minutes this week" } ],
  "icebreakers": ["a quick, fun question the whole family (kids included) can answer in a sentence"],
  "activities": ["a short togetherness activity or ritual that connects to a fun family memory or tradition"]
}
${type === 'admin'
  ? 'Give 4-6 agenda topics focused on core household tasks/plan/projects/decisions. Leave icebreakers and activities as empty arrays — this meeting is just the two of them.'
  : 'Give 4-6 agenda topics (most drawn from the week\'s real items), 2 icebreakers, and 2 activities.'} Empty arrays are fine.`;

  return generateJSON({ system, prompt, maxTokens: 1800 });
}

// ---------- House manager ----------

const HM_ROLE = (family) =>
  `You are Claudia, the Ortiz family's house manager — thoughtful, organized, and genuinely helpful. Speak as Claudia in the first person. Family: ${family.join(', ') || 'the family'}. Ground everything in the data provided: never invent events, people, dates, chores, or commitments. Be specific and warm, not generic. The household notes are BACKGROUND preference context to inform your judgment — never recite them back as suggestions (e.g. don't tell them which store to shop at or when; they already know their own habits). Skip filler: only suggest something if it's tied to a concrete item, date, or opportunity. Respond with JSON only — no markdown, no fences.`;

// Daily brief for the Home page — a short read on TODAY plus a few concrete,
// one-tap-addable suggestions. Each suggestion is typed so the app can turn it
// into a task, appointment, or grocery item.
export async function analyzeDay({ family = [], notes = '', kids = '', today, weekday = '', events = '', chores = '', groceries = '', meals = '', email = '' } = {}) {
  const system = HM_ROLE(family) + ` This is a brief morning briefing for TODAY — keep it tight and useful, the kind of thing a great house manager would say over coffee. If recent email surfaces something time-sensitive (an appointment, an RSVP, a bill, a school notice), fold it in — but only when it genuinely matters today or soon. If dinner is planned for tonight, mention it in a note. Kids (${kids || 'none listed'}) don't use the app — when a small chore genuinely fits one of them, suggest it as a task with their name in "who".`;
  const prompt = `Good morning. Today is ${weekday} ${today}. Give the family a short read on the day.

HOUSEHOLD NOTES / PREFERENCES:
${notes || '(none provided)'}

TODAY & TOMORROW ON THE CALENDAR:
${events || '(no calendar events available)'}

DINNERS PLANNED:
${meals || '(none planned)'}

OPEN CHORES:
${chores || '(none)'}

GROCERY LIST (by store):
${groceries || '(empty)'}

RECENT EMAIL (sender — subject: snippet; may be noise, use judgment):
${email || '(no email available)'}

Return JSON with exactly this shape:
{
  "headline": "one warm sentence reading the shape of the day",
  "notes": ["1-3 short lines: what matters today, timing to watch, a heads-up"],
  "suggestions": [ { "type": "task" | "appointment" | "grocery", "title": "short imperative, e.g. 'Prep gym bag for River'", "date": "YYYY-MM-DD (optional; for a task due date or appointment date)", "who": "family member name (optional; who should do it)", "detail": "one short clause on why", "store": "Costco | Walmart | Trader Joe's (REQUIRED for type grocery — match the store it's actually for; never leave it to default)" } ]
}
Give 0-4 suggestions, only genuinely useful ones for today or the next day. Never suggest a grocery item already on the list above; for grocery suggestions the title must be the bare item name (e.g. 'sunscreen'), not an action phrase. Empty arrays are fine.`;

  return generateJSON({ system, prompt, maxTokens: 1400 });
}

// Weekly review for the House Manager tab — proposes a concrete plan of items
// to complete for the rest of the week. Each item is typed so it can be added
// to the living weekly plan (or straight to tasks/calendar/grocery).
export async function reviewWeek({ family = [], notes = '', interests = '', kids = '', today, events = '', chores = '', groceries = '', plan = '', meals = '', email = '', follow = '' } = {}) {
  const system = HM_ROLE(family) +
    ' Look especially for things with lead time: birthdays/anniversaries (a card AND a gift, timed), events needing an RSVP / reservation / outfit / travel, and appointments needing prep.' +
    ' If recent email surfaces something worth planning around (an RSVP, a bill due, a school notice, an invite), fold it into the plan — only when it\'s genuinely actionable, not just noise.' +
    ' Also look OUTWARD: use web search to find 1-2 timely, real things this family would genuinely enjoy this week — a movie they\'d love playing nearby, a local event, a seasonal activity — matched to their interests and their open evenings. Include the real date, time, and venue from the search results, and only suggest what you actually verified. If nothing good is on, say nothing rather than padding.' +
    ` Kids (${kids || 'none listed'}) don't use the app — when a chore genuinely fits one of them (age-appropriate: dishes, trash, room care, packing their own bags), suggest it with their name in "who" so the parents can assign it. One kid chore per review at most; this is help, not a chore chart.` +
    ' FOLLOW-THROUGH: you get a log of your own past suggestions. Never re-ask a question the family already answered; build on their answer instead. Follow up ONCE, gently, on something that was added but never finished ("still want to get to X?"). Don\'t re-suggest something ignored twice in a row — let it go unless it becomes genuinely urgent. Briefly acknowledge a win if something you suggested got done. No nagging, no guilt, no scorekeeping.' +
    ' Do NOT suggest a grocery item that is already on the list below — check it first.';
  const prompt = `Today is ${today}. Propose a plan of what's worth getting done for the rest of this week — and anything fun worth planning around.

HOUSEHOLD NOTES / PREFERENCES (background only — do not repeat back):
${notes || '(none provided)'}

FAMILY INTERESTS (for fun / outing ideas):
${interests || '(none listed — skip outing ideas)'}

YOUR PAST SUGGESTIONS (follow-through log):
${follow || '(no history yet)'}

DINNERS PLANNED THIS WEEK:
${meals || '(none planned)'}

UPCOMING CALENDAR (next ~2 weeks):
${events || '(no calendar events available — Google Calendar may not be connected)'}

OPEN CHORES:
${chores || '(none)'}

GROCERY LIST (by store):
${groceries || '(empty)'}

RECENT EMAIL (sender — subject: snippet; may be noise, use judgment):
${email || '(no email available)'}

ALREADY ON THE WEEKLY PLAN (do not repeat these):
${plan || '(nothing planned yet)'}

Return JSON with exactly this shape:
{
  "overview": "2-3 sentences reading the week and what to prioritize",
  "planItems": [ { "title": "short imperative plan item", "detail": "one sentence: what, why, and roughly when", "suggestedType": "plan" | "task" | "appointment" | "grocery", "day": "YYYY-MM-DD (optional)", "who": "family member name (optional)", "store": "Costco | Walmart | Trader Joe's (REQUIRED for suggestedType grocery — match the store it's actually for; never leave it to default)" } ],
  "questions": ["a short question whose answer would sharpen the plan"]
}
Give 3-8 plan items, most time-sensitive first — quality over quantity; never pad with generic errands. Never suggest a grocery item already on the list above; for grocery suggestions the title must be the bare item name (e.g. 'sunscreen'), not an action phrase. Ask at most 2 questions, only when the answer would change your advice. Empty arrays are fine.`;

  return generateJSON({ system, prompt, maxTokens: 3000, tools: [webSearchTool()] });
}

// Dinner planner for the Manager tab — proposes dinners for the empty nights
// ahead, fitted to the calendar (busy evening → quick meal) and the family's
// standing food rules. Each proposal carries the ingredients so the family
// can push what's missing onto the grocery list in one tap. No web search —
// good weeknight cooking doesn't need it.
export async function planMeals({ family = [], foodNotes = '', kids = '', today, events = '', existingMeals = '', groceries = '' } = {}) {
  const system = HM_ROLE(family) + ` You are planning family dinners. Kids: ${kids || 'none listed'}. Fit each night's meal to that night's calendar — a packed evening gets a 20-minute meal or leftovers, an open weekend night can be a cooking project. Vary cuisines across the week. Real, normal meals a home cook actually makes — not restaurant fantasy.`;
  const prompt = `Today is ${today}. Propose dinners for the nights ahead that don't have one planned yet (next 7 days).

STANDING FOOD RULES:
${foodNotes || '(none — use good judgment)'}

DINNERS ALREADY PLANNED (skip these nights):
${existingMeals || '(none yet — plan the whole week)'}

EVENINGS ON THE CALENDAR (plan around these):
${events || '(no calendar events available)'}

ALREADY ON THE GROCERY LIST (prefer meals that use these):
${groceries || '(empty)'}

Return JSON with exactly this shape:
{
  "note": "one short line reading the week's cooking rhythm (optional)",
  "meals": [ { "date": "YYYY-MM-DD", "title": "the dish, short (e.g. 'Sheet-pan lemon chicken & broccoli')", "detail": "1-2 sentences: quick how-to or why it fits that night", "ingredients": ["main ingredients someone would need to buy, 3-8 items, lowercase"] } ]
}
One meal per empty night, dated correctly. Empty arrays are fine.`;

  return generateJSON({ system, prompt, maxTokens: 2400 });
}

// "Claudify" a single plan item: expand a one-line plan item into a fuller,
// concrete write-up — steps, considerations, a rough timeline — something
// you could actually hand to someone or paste into email/Notes/wherever.
// Plain text, not JSON: this is meant to be read and copied, not parsed.
export async function claudifyPlanItem({ family = [], notes = '', title, detail = '' } = {}) {
  const system = `You are Claudia, the Ortiz family's house manager. Turn one plan item into a genuinely useful, concrete write-up the family could act on directly or paste into another app or email. Ground it in what's given; never invent specifics (addresses, prices, names, dates) that aren't provided. Keep it tight — a short lead-in line, then the real content (steps, considerations, a rough timeline where relevant) as short prose or plain dashes. No JSON, no markdown headers, no filler, no restating the obvious.`;
  const prompt = `Expand this plan item for ${family.join(', ') || 'the family'} into something concrete and actionable:

PLAN ITEM: ${title}
${detail ? `NOTES ALREADY ON IT: ${detail}\n` : ''}
HOUSEHOLD NOTES / PREFERENCES (background):
${notes || '(none)'}

Write the expanded plan directly as plain text.`;

  return callClaude({ system, messages: [{ role: 'user', content: prompt }], maxTokens: 900 });
}

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

// The single transport seam. To move to a proxy later, change only this fn.
async function callClaude({ system, messages, maxTokens = 2048 }) {
  const { apiKey } = getSettings();
  if (!apiKey) {
    throw new AIError('No Claude API key set. Add one in Settings.');
  }

  const body = { model: MODEL, max_tokens: maxTokens, messages, thinking: { type: 'disabled' } };
  if (system) body.system = system;

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
  return (json.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

// Strip accidental markdown fences before JSON.parse.
function stripFences(text) {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

async function generateJSON({ system, prompt, maxTokens }) {
  const attempt = async (extra) => {
    const raw = await callClaude({
      system,
      maxTokens,
      messages: [{ role: 'user', content: prompt + (extra || '') }],
    });
    return JSON.parse(stripFences(raw));
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

// Reviews the agenda + the week ahead and returns structured guidance:
// what's already been reviewed, what still needs discussion (including
// upcoming things not yet on the agenda), a suggested meeting structure,
// and a couple of facilitation tips.
export async function reviewFamilyMeeting({ family = [], meetingDate, agenda = [], weekAhead = '' }) {
  const system = `You help the Ortiz family run a good weekly family meeting. The family members are: ${family.join(', ') || 'the family'}. Keep advice warm, concrete, and brief — this is a household ritual, not a corporate standup. Ground every suggestion in the agenda and week-ahead data provided; do not invent events, people, or commitments that aren't given. Respond with JSON only — no markdown, no fences.`;

  const reviewed = agenda.filter((a) => a.reviewed).map((a) => a.text);
  const open = agenda.filter((a) => !a.reviewed).map((a) => a.text);

  const prompt = `It's the family meeting${meetingDate ? ` for ${meetingDate}` : ''}. Help us run it well.

AGENDA ITEMS ALREADY MARKED REVIEWED:
${reviewed.length ? reviewed.map((t) => `- ${t}`).join('\n') : '(none yet)'}

AGENDA ITEMS STILL OPEN (not yet reviewed):
${open.length ? open.map((t) => `- ${t}`).join('\n') : '(none yet)'}

THE WEEK AHEAD (from our household app):
${weekAhead || '(nothing logged for the coming week)'}

Return JSON with exactly this shape:
{
  "alreadyCovered": ["short restatement of each agenda item already reviewed"],
  "needsReview": ["each still-open agenda item, PLUS anything from the week ahead that deserves a family conversation but isn't on the agenda yet — say briefly why"],
  "suggestedAgenda": [ { "topic": "short agenda topic", "why": "one sentence on why it belongs and roughly when in the meeting" } ],
  "tips": ["2-3 brief, practical tips for making this specific meeting go well"]
}

Keep the suggested agenda to a realistic 20-30 minute family meeting (4-6 topics). If a section has nothing, return an empty array.`;

  return generateJSON({ system, prompt, maxTokens: 1800 });
}

// Drafts a full family-meeting plan from the week — a proposed agenda drawn
// from real events and open items, plus fun icebreakers and togetherness
// activities that get everyone (including the kids) participating.
export async function draftMeeting({ family = [], notes = '', meetingDate, weekAhead = '', openItems = '', currentAgenda = '' } = {}) {
  const system = `You help the Ortiz family run a warm, fun weekly family meeting. Family: ${family.join(', ') || 'the family'} (Sedona and River are kids). Draft an agenda drawn from the week's real events and open items — never invent events, people, or commitments. Make it feel like a family moment, not a status meeting: include quick icebreakers the kids will enjoy and short activities that build participation and togetherness. Keep everything concrete and kid-friendly. Respond with JSON only — no markdown, no fences.`;

  const prompt = `Draft this week's family meeting${meetingDate ? ` for ${meetingDate}` : ''}.

FAMILY NOTES / PREFERENCES:
${notes || '(none)'}

THE WEEK AHEAD (real calendar + household):
${weekAhead || '(nothing logged)'}

OPEN ITEMS FROM DURING THE WEEK (tasks, plans worth raising):
${openItems || '(none)'}

ALREADY ON THE AGENDA (do not repeat):
${currentAgenda || '(nothing yet)'}

Return JSON with exactly this shape:
{
  "draftAgenda": [ { "topic": "short agenda topic", "why": "one line: why it's worth 2 minutes this week" } ],
  "icebreakers": ["a quick, fun question the whole family (kids included) can answer in a sentence"],
  "activities": ["a short togetherness activity or ritual to do during the meeting"]
}
Give 4-6 agenda topics (most drawn from the week's real items), 2 icebreakers, and 2 activities. Empty arrays are fine.`;

  return generateJSON({ system, prompt, maxTokens: 1800 });
}

// ---------- House manager ----------

const HM_ROLE = (family) =>
  `You are the Ortiz family's house manager — thoughtful, organized, and genuinely helpful. Family: ${family.join(', ') || 'the family'}. Ground everything in the data provided: never invent events, people, dates, chores, or commitments. Be specific and warm, not generic. Respond with JSON only — no markdown, no fences.`;

// Daily brief for the Home page — a short read on TODAY plus a few concrete,
// one-tap-addable suggestions. Each suggestion is typed so the app can turn it
// into a task, appointment, or grocery item.
export async function analyzeDay({ family = [], notes = '', today, weekday = '', events = '', chores = '', upkeep = '', groceries = '', email = '' } = {}) {
  const system = HM_ROLE(family) + ' This is a brief morning briefing for TODAY — keep it tight and useful, the kind of thing a great house manager would say over coffee. If recent email surfaces something time-sensitive (an appointment, an RSVP, a bill, a school notice), fold it in — but only when it genuinely matters today or soon.';
  const prompt = `Good morning. Today is ${weekday} ${today}. Give the family a short read on the day.

HOUSEHOLD NOTES / PREFERENCES:
${notes || '(none provided)'}

TODAY & TOMORROW ON THE CALENDAR:
${events || '(no calendar events available)'}

OPEN CHORES:
${chores || '(none)'}

UPKEEP DUE / OVERDUE:
${upkeep || '(none)'}

GROCERY LIST (by store):
${groceries || '(empty)'}

RECENT EMAIL (sender — subject: snippet; may be noise, use judgment):
${email || '(no email available)'}

Return JSON with exactly this shape:
{
  "headline": "one warm sentence reading the shape of the day",
  "notes": ["1-3 short lines: what matters today, timing to watch, a heads-up"],
  "suggestions": [ { "type": "task" | "appointment" | "grocery", "title": "short imperative, e.g. 'Prep gym bag for River'", "date": "YYYY-MM-DD (optional; for a task due date or appointment date)", "detail": "one short clause on why" } ]
}
Give 0-4 suggestions, only genuinely useful ones for today or the next day. Empty arrays are fine.`;

  return generateJSON({ system, prompt, maxTokens: 1400 });
}

// Weekly review for the House Manager tab — proposes a concrete plan of items
// to complete for the rest of the week. Each item is typed so it can be added
// to the living weekly plan (or straight to tasks/calendar/grocery).
export async function reviewWeek({ family = [], notes = '', today, events = '', chores = '', upkeep = '', groceries = '', plan = '' } = {}) {
  const system = HM_ROLE(family) + ' Look especially for things with lead time: birthdays/anniversaries (a card AND a gift, timed), events needing an RSVP / reservation / outfit / travel, appointments needing prep, and good windows to run errands or book vendors given the family\'s habits.';
  const prompt = `Today is ${today}. Propose a plan of what's worth getting done for the rest of this week.

HOUSEHOLD NOTES / PREFERENCES:
${notes || '(none provided)'}

UPCOMING CALENDAR (next ~2 weeks):
${events || '(no calendar events available — Google Calendar may not be connected)'}

OPEN CHORES:
${chores || '(none)'}

UPKEEP DUE / OVERDUE:
${upkeep || '(none)'}

GROCERY LIST (by store):
${groceries || '(empty)'}

ALREADY ON THE WEEKLY PLAN (do not repeat these):
${plan || '(nothing planned yet)'}

Return JSON with exactly this shape:
{
  "overview": "2-3 sentences reading the week and what to prioritize",
  "planItems": [ { "title": "short imperative plan item", "detail": "one sentence: what, why, and roughly when", "suggestedType": "plan" | "task" | "appointment" | "grocery", "day": "YYYY-MM-DD (optional)" } ],
  "questions": ["a short question whose answer would sharpen the plan"]
}
Give 4-8 plan items, most time-sensitive first. Ask at most 2 questions, only when the answer would change your advice. Empty arrays are fine.`;

  return generateJSON({ system, prompt, maxTokens: 2200 });
}

// Free-form Q&A for the Manager tab — answers a question grounded in the
// family's calendar, email, tasks, plan, and groceries. Returns a short
// answer plus any concrete one-tap actions it wants to offer. `briefNote`
// is a one-line version the family can pin to tomorrow's morning brief.
export async function askManager({ family = [], notes = '', today, weekday = '', question, events = '', email = '', chores = '', upkeep = '', groceries = '', plan = '' } = {}) {
  const system = HM_ROLE(family) + ' Answer the question directly and concretely using ONLY the data below. If the data doesn\'t contain the answer, say so plainly rather than guessing. Keep the answer to a few sentences.';
  const prompt = `Today is ${weekday} ${today}. Answer this question for the family:

"${question}"

CALENDAR (upcoming):
${events || '(no calendar events available)'}

RECENT EMAIL (sender — subject: snippet):
${email || '(no email available)'}

OPEN CHORES:
${chores || '(none)'}

UPKEEP DUE / OVERDUE:
${upkeep || '(none)'}

GROCERY LIST:
${groceries || '(empty)'}

WEEKLY PLAN:
${plan || '(nothing planned)'}

Return JSON with exactly this shape:
{
  "answer": "a direct, few-sentence answer grounded in the data above",
  "briefNote": "one short line suitable for tomorrow's morning brief, or empty if not worth surfacing",
  "suggestions": [ { "type": "task" | "appointment" | "grocery", "title": "short imperative action", "date": "YYYY-MM-DD (optional)", "detail": "one short clause" } ]
}
Offer 0-3 suggestions, only genuinely useful ones. Empty arrays/strings are fine.`;

  return generateJSON({ system, prompt, maxTokens: 1600 });
}

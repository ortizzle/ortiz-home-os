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

// ---------- House-manager review ----------

// Reviews the upcoming calendar + household state and returns proactive,
// at-a-glance ideas a good house manager would surface — birthdays/events
// that need a card, gift, RSVP or reservation; appointments needing prep;
// good windows for errands given the family's shopping habits; overdue
// upkeep. It can also ask clarifying questions.
export async function reviewHousehold({ family = [], notes = '', today, events = '', chores = '', upkeep = '', groceries = '' } = {}) {
  const system = `You are the Ortiz family's proactive house manager. Family: ${family.join(', ') || 'the family'}. Be genuinely helpful and specific — anticipate what a thoughtful, organized person running this household would flag this week. Look especially for things with lead time: birthdays and anniversaries (suggest a card AND a gift, ordered in time), events needing an RSVP / reservation / outfit / travel, appointments that need preparation, and good windows to run errands or book vendors. Ground every idea in the data provided — never invent events, people, dates, or commitments. If something genuinely needs the family's input to advise well, put it under "questions" (ask at most 3, only when it would change your advice). Respond with JSON only — no markdown, no fences.`;

  const prompt = `Today is ${today}. Review what's coming up and give us helpful ideas at a glance.

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

Return JSON with exactly this shape:
{
  "ideas": [ { "title": "short headline of the idea", "detail": "1-2 sentences on what and why, with the specific date/person", "actions": ["a concrete next step", "..."] } ],
  "questions": ["a short question whose answer would sharpen your advice"]
}

Give 3-6 ideas, most time-sensitive first. Keep it concrete and warm, not generic. If a section has nothing, return an empty array.`;

  return generateJSON({ system, prompt, maxTokens: 2200 });
}

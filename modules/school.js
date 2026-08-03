// school.js — a read-only window into the girls' school apps (Ad Astra =
// Sedona, Wayfinder = River). Both apps sync their full record store to a
// private Gist; this module reads those Gists with the same household token,
// recomputes the numbers the apps themselves derive (streak, minutes,
// accuracy — never stored, so they can't drift), and hands compact summaries
// to the dashboard, the digest, and Claudia's prompts.
//
// PARENT-ONLY by design: mood check-ins and the girls' verbatim tutor
// questions live in those payloads too — they are deliberately never read
// here. Aggregate study/test signal only.
//
// Consumer invariants (mirrors the apps' own rules — see their CLAUDE.md):
//   · filter tombstoned records (r.deleted)
//   · recompute stats, never look for stored ones
//   · all date math on local YYYY-MM-DD strings (family devices run AZ time)

import { getSettings } from './store.js';
import { addDays, parseDate, todayStr, fmtDay } from './ui.js';

// School-wide exam/review windows live hardcoded in each app's CAL (not in
// the Gist), so a copy lives here. Keep in sync with ad-astra/wayfinder
// index.html CAL.events when the schools publish new dates.
// Class-id → short label maps mirror each app's CLASSES array — records only
// carry the id.
const SCHOOL_APPS = {
  'ad-astra-data.json': {
    app: 'Ad Astra',
    url: 'https://ortizzle.github.io/ad-astra/',
    settingKey: 'adAstraGistId',
    fallbackName: 'Sedona',
    classes: { theatre: 'Theatre', algeo: 'Alg/Geo', bio: 'Biology', physics: 'Physics', history: 'History', english: 'English', latin: 'Latin' },
    events: [
      { start: '2026-12-07', end: '2026-12-14', name: 'Pre-Comp review window', kind: 'review' },
      { start: '2026-12-15', end: '2026-12-16', name: 'Pre-Comp Exams', kind: 'exam' },
      { start: '2027-05-03', end: '2027-05-10', name: 'Comp review window', kind: 'review' },
      { start: '2027-05-11', end: '2027-05-13', name: 'Comp Exams', kind: 'exam' },
    ],
  },
  'wayfinder-data.json': {
    app: 'Wayfinder',
    url: 'https://ortizzle.github.io/wayfinder/',
    settingKey: 'wayfinderGistId',
    fallbackName: 'River',
    classes: { math: 'Math', english: 'English', writing: 'Writing', science: 'Science', history: 'History', engineering: 'Engineering', computer: 'Computers', arts: 'Art', theatre: 'Theatre', pe: 'PE', martial: 'Martial Arts', study: 'Study Hall' },
    events: [
      { start: '2026-08-11', end: '2026-08-12', name: 'Mini-Comps', kind: 'exam' },
      { start: '2026-08-17', end: '2026-08-19', name: 'Fast Bridge testing (benchmark — nothing to revise for)', kind: 'benchmark' },
    ],
  },
};

const KIND_NAMES = { test: 'test', quiz: 'quiz', project: 'project', essay: 'essay', present: 'presentation' };

const CACHE_KEY = 'ohos.schoolCache';
const CACHE_TTL_MIN = 15;
const LOOKAHEAD_DAYS = 21; // how far out tests/exams are surfaced

export function schoolConfigured() {
  const s = getSettings();
  return Boolean(s.gistToken && Object.values(SCHOOL_APPS).some((a) => (s[a.settingKey] || '').trim()));
}

const daysBetween = (a, b) => Math.round((parseDate(b) - parseDate(a)) / 86400000);

// ---------- Gist read (read-only — this module never writes to the apps) ----------

async function fetchAppPayload(gistId, token) {
  const res = await fetch(`https://api.github.com/gists/${gistId}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`Gist ${res.status}`);
  const gist = await res.json();
  const files = Object.values(gist.files || {});
  const file = files.find((f) => SCHOOL_APPS[f.filename]) || files.find((f) => f.filename.endsWith('-data.json'));
  if (!file) throw new Error('No school data file in this gist');
  const text = file.truncated ? await (await fetch(file.raw_url)).text() : file.content;
  return { filename: file.filename, payload: JSON.parse(text || '{"records":{}}') };
}

// ---------- summarize one kid (mirrors the app's own derived-stats formulas) ----------

function summarize(payload, meta, today) {
  const recs = Object.values(payload.records || {}).filter((r) => r && !r.deleted);
  const of = (t) => recs.filter((r) => r.type === t);
  const logs = of('log');
  const focus = of('focus');
  const misses = of('miss');
  const assess = of('assess');
  const roster = recs.find((r) => r.type === 'roster') || {};
  const prefs = recs.find((r) => r.type === 'prefs') || {};
  const classLabel = (id) => meta.classes[id] || (id ? id[0].toUpperCase() + id.slice(1) : '');

  // Streak + engagement — same day-set rule as the app: quiz/card sessions
  // and focus timers count, XP-only records don't.
  const daySet = new Set([...logs.map((l) => l.date), ...focus.map((f) => f.date)].filter(Boolean));
  let streak = 0;
  let cur = today;
  if (!daySet.has(cur)) cur = addDays(cur, -1);
  while (daySet.has(cur)) { streak++; cur = addDays(cur, -1); }
  const lastActive = [...daySet].sort().at(-1) || null;

  const weekStart = addDays(today, -parseDate(today).getDay()); // Sunday, like the app
  const inWeek = (r) => r.date >= weekStart && r.date <= today;
  const minutesWeek = Math.round(
    logs.filter(inWeek).reduce((s, l) => s + (l.seconds || 0) / 60, 0) +
    focus.filter(inWeek).reduce((s, f) => s + (f.minutes || 0), 0)
  );
  const goalWeek = Object.values(prefs.goals || {}).reduce((s, n) => s + (Number(n) || 0), 0);
  const sessionsWeek = logs.filter(inWeek).length;

  // Accuracy — overall and the last 7 days.
  const acc = (list) => {
    const t = list.reduce((s, l) => s + (l.total || 0), 0);
    return t ? Math.round((list.reduce((s, l) => s + (l.correct || 0), 0) / t) * 100) : null;
  };
  const accuracy = acc(logs);
  const recentAccuracy = acc(logs.filter((l) => l.date >= addDays(today, -7)));

  // Per-class read: accuracy, last studied, upcoming test — powers the
  // "test coming up in a class she hasn't touched" alert.
  const byClass = {};
  for (const l of [...logs, ...focus]) {
    if (!l.classId) continue;
    const c = (byClass[l.classId] ||= { label: classLabel(l.classId), correct: 0, total: 0, lastOn: null });
    c.correct += l.correct || 0;
    c.total += l.total || 0;
    if (l.date && (!c.lastOn || l.date > c.lastOn)) c.lastOn = l.date;
  }
  const weakClasses = Object.values(byClass)
    .map((c) => ({ ...c, accuracy: c.total ? Math.round((c.correct / c.total) * 100) : null }))
    .filter((c) => c.accuracy !== null && c.accuracy < 70)
    .sort((a, b) => a.accuracy - b.accuracy);

  // Upcoming: per-class tests (parent-entered `assess` records) joined with
  // the school-wide exam windows from the CAL copy above.
  const horizon = addDays(today, LOOKAHEAD_DAYS);
  const upcoming = [
    ...assess
      .filter((a) => a.date && a.date >= today && a.date <= horizon)
      .map((a) => ({
        date: a.date,
        label: `${classLabel(a.classId)} ${KIND_NAMES[a.kind] || 'test'}`.trim(),
        title: a.title || '',
        classId: a.classId,
        kind: 'assess',
      })),
    ...meta.events
      .filter((e) => (e.end || e.start) >= today && e.start <= horizon)
      .map((e) => ({ date: e.start, end: e.end, label: e.name, kind: e.kind })),
  ].sort((a, b) => a.date.localeCompare(b.date));

  // The heads-up Home OS exists to give: a class test inside a week while
  // that class hasn't been studied in 4+ days (or ever).
  const alerts = [];
  for (const u of upcoming) {
    if (u.kind !== 'assess' || daysBetween(today, u.date) > 7) continue;
    const c = byClass[u.classId];
    const idle = c && c.lastOn ? daysBetween(c.lastOn, today) : null;
    if (idle === null) alerts.push(`${u.label} ${whenPhrase(today, u.date)} and ${classLabel(u.classId)} hasn't been studied yet`);
    else if (idle >= 4) alerts.push(`${u.label} ${whenPhrase(today, u.date)} but ${classLabel(u.classId)} hasn't been studied in ${idle} days`);
  }

  // Recent real scores (parent-entered after the fact) — the outcome loop.
  const recentScores = assess
    .filter((a) => a.score != null && a.date && a.date >= addDays(today, -30) && a.date <= today)
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((a) => ({ date: a.date, label: `${classLabel(a.classId)} ${KIND_NAMES[a.kind] || 'test'}`.trim(), score: a.score }));

  const growthDue = misses.filter((m) => !m.due || m.due <= today).length;

  return {
    app: meta.app,
    url: meta.url,
    name: (roster.studentName || '').trim() || meta.fallbackName,
    hasActivity: logs.length > 0 || focus.length > 0,
    streak,
    lastActive,
    minutesWeek,
    goalWeek,
    sessionsWeek,
    accuracy,
    recentAccuracy,
    growthDue,
    weakClasses,
    upcoming,
    alerts,
    recentScores,
  };
}

// "today" / "tomorrow" / "in 4 days" — shared phrasing for lines and alerts.
export function whenPhrase(today, date) {
  const d = daysBetween(today, date);
  return d <= 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`;
}

// One upcoming item as display text: "Physics test Wed, Aug 5 (in 3 days)".
export function upcomingLabel(today, u) {
  const range = u.end && u.end > u.date ? `${fmtDay(u.date)}–${fmtDay(u.end)}` : fmtDay(u.date);
  return `${u.label} ${range} (${whenPhrase(today, u.date)})`;
}

// ---------- fetch + cache ----------
// Summaries (not raw payloads — those carry the whole study-set library) are
// cached ~15 min so Home renders instantly and a brief + digest + dashboard
// in one sitting costs two Gist reads, not six.

function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || null; } catch { return null; }
}

function writeCache(entry) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(entry)); } catch {}
}

let inFlight = null;

// Returns { kids: [summary…], fetchedAt, stale } or null when unconfigured /
// nothing reachable. Never throws — school data is an overlay, and a Gist
// hiccup must not take down the dashboard or a brief.
export async function getSchoolSummaries({ force = false } = {}) {
  const s = getSettings();
  const apps = Object.values(SCHOOL_APPS)
    .map((meta) => ({ meta, gistId: (s[meta.settingKey] || '').trim() }))
    .filter((a) => a.gistId);
  if (!apps.length || !s.gistToken) return null;

  const cached = readCache();
  const fresh = cached && Date.now() - cached.at < CACHE_TTL_MIN * 60_000;
  if (fresh && !force) return { kids: cached.kids, fetchedAt: cached.at, stale: false };

  if (inFlight) return inFlight;
  inFlight = (async () => {
    const today = todayStr();
    let anyLive = false;
    const kids = (
      await Promise.all(
        apps.map(async ({ meta, gistId }) => {
          try {
            const { filename, payload } = await fetchAppPayload(gistId, s.gistToken);
            anyLive = true;
            // Trust the filename over the settings slot if they disagree —
            // an ID pasted in the wrong field still summarizes correctly.
            return summarize(payload, SCHOOL_APPS[filename] || meta, today);
          } catch (err) {
            console.warn(`school: ${meta.app} fetch failed`, err);
            // Fall back to this kid's last good summary rather than dropping
            // them from every surface over one failed request.
            return cached?.kids?.find((k) => k.app === meta.app) || null;
          }
        })
      )
    ).filter(Boolean);
    if (!kids.length) return null;
    if (anyLive) writeCache({ at: Date.now(), kids });
    return { kids, fetchedAt: anyLive ? Date.now() : cached?.at, stale: !anyLive };
  })().finally(() => { inFlight = null; });
  return inFlight;
}

// ---------- prompt block ----------
// The compact text Claudia reads. Facts only, one kid per stanza — the
// prompts (ai.js) tell her how to use it (timely nudges, never guilt).

export function schoolText(kids) {
  const today = todayStr();
  return (kids || [])
    .map((k) => {
      const lines = [`${k.name.toUpperCase()} (${k.app}):`];
      if (k.upcoming.length) {
        lines.push(`- Upcoming: ${k.upcoming.slice(0, 4).map((u) => upcomingLabel(today, u) + (u.title ? ` — "${u.title}"` : '')).join('; ')}`);
      } else {
        lines.push(`- Upcoming: no tests entered for the next ${LOOKAHEAD_DAYS} days`);
      }
      if (!k.hasActivity) {
        lines.push('- Engagement: no study activity logged in the app yet');
      } else {
        lines.push(
          `- Engagement: ${k.streak ? `${k.streak}-day streak` : 'no current streak'}; last studied ${k.lastActive ? fmtDay(k.lastActive) : 'never'}; ` +
          `${k.minutesWeek} min this week${k.goalWeek ? ` (weekly goal ${k.goalWeek} min)` : ''}; ${k.sessionsWeek} quiz session${k.sessionsWeek === 1 ? '' : 's'} this week`
        );
        if (k.accuracy !== null) {
          lines.push(`- Accuracy: ${k.accuracy}% overall${k.recentAccuracy !== null ? `; last 7 days ${k.recentAccuracy}%` : ''}${k.weakClasses.length ? `; weak spots: ${k.weakClasses.map((c) => `${c.label} ${c.accuracy}%`).join(', ')}` : ''}`);
        }
        if (k.growthDue) lines.push(`- Growth Zone: ${k.growthDue} missed question${k.growthDue === 1 ? '' : 's'} due for review`);
        if (k.recentScores.length) lines.push(`- Recent scores: ${k.recentScores.slice(0, 2).map((r) => `${r.label} ${r.score}% (${fmtDay(r.date)})`).join('; ')}`);
      }
      for (const a of k.alerts) lines.push(`- ALERT: ${a}`);
      return lines.join('\n');
    })
    .join('\n');
}

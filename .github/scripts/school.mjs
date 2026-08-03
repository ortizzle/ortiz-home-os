// school.mjs — node-side reader for the girls' school-app Gists (Ad Astra =
// Sedona, Wayfinder = River), used by the scheduled emails. Mirrors the
// browser module (modules/school.js): filter tombstoned records, recompute
// stats (never stored), Arizona dates. Parent-facing aggregate signal only —
// mood check-ins and tutor questions are deliberately never read.
//
// Config: SCHOOL_GIST_IDS (comma-separated Gist IDs, repo secret) +
// GIST_TOKEN (the same token the household sync jobs already use). Unset →
// returns [] and the emails simply skip the section.
import { today, addDays, parseDate, fmtDay } from './home-os.mjs';

// Class-id → label maps and school-wide exam windows mirror each app's CLASSES
// and CAL.events (hardcoded in their index.html, not in the Gist). Keep in
// sync with modules/school.js.
const SCHOOL_APPS = {
  'ad-astra-data.json': {
    app: 'Ad Astra',
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
    fallbackName: 'River',
    classes: { math: 'Math', english: 'English', writing: 'Writing', science: 'Science', history: 'History', engineering: 'Engineering', computer: 'Computers', arts: 'Art', theatre: 'Theatre', pe: 'PE', martial: 'Martial Arts', study: 'Study Hall' },
    events: [
      { start: '2026-08-11', end: '2026-08-12', name: 'Mini-Comps', kind: 'exam' },
      { start: '2026-08-17', end: '2026-08-19', name: 'Fast Bridge testing (benchmark — nothing to revise for)', kind: 'benchmark' },
    ],
  },
};

const KIND_NAMES = { test: 'test', quiz: 'quiz', project: 'project', essay: 'essay', present: 'presentation' };
const LOOKAHEAD_DAYS = 21;

const daysBetween = (a, b) => Math.round((parseDate(b) - parseDate(a)) / 86400000);

export function whenPhrase(base, date) {
  const d = daysBetween(base, date);
  return d <= 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`;
}

export function upcomingLabel(base, u) {
  const range = u.end && u.end > u.date ? `${fmtDay(u.date)}–${fmtDay(u.end)}` : fmtDay(u.date);
  return `${u.label} ${range} (${whenPhrase(base, u.date)})`;
}

function summarize(payload, meta, base) {
  const recs = Object.values(payload.records || {}).filter((r) => r && !r.deleted);
  const of = (t) => recs.filter((r) => r.type === t);
  const logs = of('log');
  const focus = of('focus');
  const assess = of('assess');
  const roster = recs.find((r) => r.type === 'roster') || {};
  const prefs = recs.find((r) => r.type === 'prefs') || {};
  const classLabel = (id) => meta.classes[id] || (id ? id[0].toUpperCase() + id.slice(1) : '');

  const daySet = new Set([...logs.map((l) => l.date), ...focus.map((f) => f.date)].filter(Boolean));
  let streak = 0;
  let cur = base;
  if (!daySet.has(cur)) cur = addDays(cur, -1);
  while (daySet.has(cur)) { streak++; cur = addDays(cur, -1); }
  const lastActive = [...daySet].sort().at(-1) || null;

  const weekStart = addDays(base, -parseDate(base).getDay()); // Sunday, like the apps
  const inWeek = (r) => r.date >= weekStart && r.date <= base;
  const minutesWeek = Math.round(
    logs.filter(inWeek).reduce((s, l) => s + (l.seconds || 0) / 60, 0) +
    focus.filter(inWeek).reduce((s, f) => s + (f.minutes || 0), 0)
  );
  const goalWeek = Object.values(prefs.goals || {}).reduce((s, n) => s + (Number(n) || 0), 0);

  const total = logs.reduce((s, l) => s + (l.total || 0), 0);
  const accuracy = total ? Math.round((logs.reduce((s, l) => s + (l.correct || 0), 0) / total) * 100) : null;

  const lastOnByClass = {};
  for (const l of [...logs, ...focus]) {
    if (!l.classId || !l.date) continue;
    if (!lastOnByClass[l.classId] || l.date > lastOnByClass[l.classId]) lastOnByClass[l.classId] = l.date;
  }

  const horizon = addDays(base, LOOKAHEAD_DAYS);
  const upcoming = [
    ...assess
      .filter((a) => a.date && a.date >= base && a.date <= horizon)
      .map((a) => ({ date: a.date, label: `${classLabel(a.classId)} ${KIND_NAMES[a.kind] || 'test'}`.trim(), classId: a.classId, kind: 'assess' })),
    ...meta.events
      .filter((e) => (e.end || e.start) >= base && e.start <= horizon)
      .map((e) => ({ date: e.start, end: e.end, label: e.name, kind: e.kind })),
  ].sort((a, b) => a.date.localeCompare(b.date));

  const alerts = [];
  for (const u of upcoming) {
    if (u.kind !== 'assess' || daysBetween(base, u.date) > 7) continue;
    const lastOn = lastOnByClass[u.classId];
    const idle = lastOn ? daysBetween(lastOn, base) : null;
    if (idle === null) alerts.push(`${u.label} ${whenPhrase(base, u.date)} and ${classLabel(u.classId)} hasn't been studied yet`);
    else if (idle >= 4) alerts.push(`${u.label} ${whenPhrase(base, u.date)} but ${classLabel(u.classId)} hasn't been studied in ${idle} days`);
  }

  const recentScores = assess
    .filter((a) => a.score != null && a.date && a.date >= addDays(base, -14) && a.date <= base)
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((a) => ({ date: a.date, label: `${classLabel(a.classId)} ${KIND_NAMES[a.kind] || 'test'}`.trim(), score: a.score }));

  return {
    app: meta.app,
    name: (roster.studentName || '').trim() || meta.fallbackName,
    hasActivity: logs.length > 0 || focus.length > 0,
    streak, lastActive, minutesWeek, goalWeek, accuracy,
    upcoming, alerts, recentScores,
  };
}

// Read every configured school Gist → one summary per kid. Never throws over
// a single unreachable Gist; a fully missing config returns [].
export async function readSchoolKids() {
  const { SCHOOL_GIST_IDS, GIST_TOKEN } = process.env;
  const ids = (SCHOOL_GIST_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length || !GIST_TOKEN) return [];
  const base = today();
  const kids = await Promise.all(ids.map(async (id) => {
    try {
      const res = await fetch(`https://api.github.com/gists/${id}`, {
        headers: { Authorization: `Bearer ${GIST_TOKEN}`, Accept: 'application/vnd.github+json' },
      });
      if (!res.ok) throw new Error(`Gist ${res.status}`);
      const gist = await res.json();
      const files = Object.values(gist.files || {});
      const file = files.find((f) => SCHOOL_APPS[f.filename]) || files.find((f) => f.filename.endsWith('-data.json'));
      if (!file) throw new Error('no school data file');
      const text = file.truncated ? await (await fetch(file.raw_url)).text() : file.content;
      const meta = SCHOOL_APPS[file.filename] || { app: file.filename, fallbackName: 'Student', classes: {}, events: [] };
      return summarize(JSON.parse(text || '{"records":{}}'), meta, base);
    } catch (err) {
      console.warn(`school: gist ${id.slice(0, 6)}… failed: ${err.message}`);
      return null;
    }
  }));
  return kids.filter(Boolean);
}

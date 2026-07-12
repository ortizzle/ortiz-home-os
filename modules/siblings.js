// siblings.js — read-only, same-origin access to the sibling apps' data.
// The whole suite deploys to ortizzle.github.io/<app>/ — ONE browser origin —
// so IndexedDB written by Learning OS and Focus OS is directly readable here
// with no server and no sync. Suite rules (ROADMAP in ortiz-focus-os):
// reads only — each app stays the sole writer of its own database — and
// never create a sibling's DB from this side.

// The family. `path` is origin-relative so links work on GitHub Pages and on
// the local suite server (ortiz-focus-os/.claude/serve-suite.js) alike.
export const SUITE = [
  { id: 'dlos', name: 'Learning OS', path: '/deep-learning-os/', db: 'deep-learning-os', tagline: 'Lessons, quizzes, coach' },
  { id: 'ofos', name: 'Focus OS', path: '/ortiz-focus-os/', db: 'ortiz-focus-os', tagline: 'Tasks, notes, focus timer' },
  { id: 'ohos', name: 'Home OS', path: '/ortiz-home-os/', db: 'ortiz-home-os', tagline: 'The household' },
];

export const siblings = SUITE.filter((a) => a.id !== 'ohos');

// ---------- safe existence check + open ----------

// A bare indexedDB.open() CREATES a missing database, which would then
// shadow the sibling app's own first-run upgrade and break it. Prefer
// indexedDB.databases() (Safari 14+ / all modern engines); as a fallback,
// abort the version-change transaction the moment onupgradeneeded fires with
// oldVersion 0 — aborting cancels the creation entirely.
export async function siblingDbExists(dbName) {
  if (indexedDB.databases) {
    try {
      return (await indexedDB.databases()).some((d) => d.name === dbName);
    } catch {
      /* fall through to the open-and-abort probe */
    }
  }
  return new Promise((resolve) => {
    let existed = true;
    const req = indexedDB.open(dbName);
    req.onupgradeneeded = (e) => {
      if (e.oldVersion === 0) {
        existed = false;
        e.target.transaction.abort();
      }
    };
    req.onsuccess = () => {
      req.result.close();
      resolve(existed);
    };
    req.onerror = () => resolve(false); // aborted creation lands here
  });
}

export async function anySiblingData() {
  const checks = await Promise.all(siblings.map((a) => siblingDbExists(a.db)));
  return checks.some(Boolean);
}

// Read whole object stores from a sibling database. Returns
// { storeName: records[] } — missing stores read as [] — or null when the
// database doesn't exist on this origin yet.
export async function readSibling(dbName, storeNames) {
  if (!(await siblingDbExists(dbName))) return null;
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName); // no version: never upgrades
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  try {
    const out = {};
    for (const name of storeNames) {
      out[name] = await new Promise((resolve) => {
        if (!db.objectStoreNames.contains(name)) return resolve([]);
        const req = db.transaction(name, 'readonly').objectStore(name).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
    }
    return out;
  } finally {
    db.close();
  }
}

// ---------- day boundaries, per each app's own convention ----------

// Focus OS pins its day to device-local time.
function localDay(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function sameLocalDay(iso, dayStr) {
  return localDay(new Date(iso)) === dayStr;
}

// Learning OS pins its day to Arizona time (America/Phoenix, no DST).
function azDay(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix' }).format(d);
}

// ---------- today summaries ----------

// Focus OS today: open tasks due or overdue, minutes focused, streak.
// Null when Focus OS has no data on this origin.
export async function focusToday() {
  const data = await readSibling('ortiz-focus-os', ['tasks', 'focusSessions', 'profile']);
  if (!data) return null;
  const today = localDay();
  const open = data.tasks.filter((t) => !t.done);
  const due = open
    .filter((t) => t.dueDate && t.dueDate <= today)
    .sort((a, b) => ((a.dueDate || '') < (b.dueDate || '') ? -1 : 1));
  const doneToday = data.tasks.filter((t) => t.done && t.doneAt && sameLocalDay(t.doneAt, today));
  const minFocused = data.focusSessions
    .filter((s) => s.completed && s.startedAt && sameLocalDay(s.startedAt, today))
    .reduce((sum, s) => sum + (s.durationMin || 0), 0);
  const profile = data.profile.find((p) => p.id === 'me') || {};
  return { today, due, doneToday: doneToday.length, openCount: open.length, minFocused, streak: profile.streak || 0 };
}

// Learning OS today: the daily checklist (habits + lesson actions), lessons
// completed today, streak. Null when Learning OS has no data on this origin.
export async function learningToday() {
  const data = await readSibling('deep-learning-os', ['tasks', 'lessons', 'profile']);
  if (!data) return null;
  const today = azDay();
  const items = data.tasks
    .filter((t) => t.date === today && t.status !== 'expired')
    .sort((a, b) => (a.type === b.type ? 0 : a.type === 'habit' ? -1 : 1));
  const lessonsDoneToday = data.lessons.filter(
    (l) => l.completedAt && azDay(new Date(l.completedAt)) === today
  ).length;
  const profile = data.profile.find((p) => p.id === 'me') || {};
  return { today, items, lessonsDoneToday, streak: profile.streak || 0 };
}

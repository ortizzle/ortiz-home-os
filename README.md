# Ortiz Home OS

The Ortiz household's shared home manager — one task list, the family
calendar, the two-week planning horizon, family meetings, and
**Claudia**, the AI house manager who reads it all. Third app in the Ortiz OS
family, alongside [Learning OS](https://ortizzle.github.io/deep-learning-os/)
and [Focus OS](https://ortizzle.github.io/ortiz-focus-os/).

## The goal (read this before adding anything)

Help Chris and Kat run the house with less coordination overhead. The proven
core is the **calendar, the task list, and the daily brief** — the goal going
forward is making that core accurate, low-friction, and trustworthy, not
making the app wider. Claudia's job is the remembering, the nudging, and the
breaking-down; she must never re-raise what the family already settled.

Full phase history and the standing product rules live in
[ortiz-home-os-kickoff.md](ortiz-home-os-kickoff.md) — the "v4 — streamline"
rules there are the bar every new feature has to clear.

**Stack:** vanilla HTML/CSS/JS, ES modules, no build step. Local-first
(IndexedDB) with shared private-Gist sync — both phones configure the same
token + Gist ID and merge (newest-updatedAt wins, tombstones keep deletions
deleted). Every record is stamped `by` the device that created it.

## Run locally

```
node .claude/serve.js   # serves on http://localhost:8125
```

## How it thinks

- **One list.** Tasks is the single capture surface for to-dos; a "plan" is
  just a dateless task (Someday). Multi-step work lives as **subtasks** on
  the task, not as prose or a second list.
- **Settled means settled.** "Not needed" logs a dismissal that suppresses
  the suggestion for ~3 weeks; meeting decisions feed every prompt for 21
  days; resolved questions aren't re-asked. Trust in the brief depends on
  this.
- **Memory is standing facts.** Claudia's memory store holds lean, typed,
  editable facts (family, pets, rhythms) fed to every prompt. One-time
  answers are remembered only via explicit opt-in — they expire otherwise.
- **Attribution over guessing.** Google events carry their source calendar
  ([Family] = shared, a parent's calendar = theirs); duplicates resolve to
  the Family copy. Claudia reads that signal instead of guessing.
- **Deterministic where possible.** Due dates, birthdays, the 2 Weeks
  summary, and the digest are computed, not asked of the AI; Claudia
  interprets on top of them.
- **Two weeks is the planning horizon.** The 2 Weeks tab (summary + month
  grid + collapsible week rundowns) and Claudia's brief both look 14 days
  out, so exams and plans that need lead time surface early. (Groceries
  moved out of the app in v79; the Keep paste-import lives on in Tasks.)

## Working on this repo

Multiple Claude Code sessions ship here in parallel. **Always `git fetch`
and build on `origin/main` before starting**, and bump the version label
(`APP_VERSION` in app.js + the `CACHE` name in sw.js) when shipping.

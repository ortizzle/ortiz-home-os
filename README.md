# Ortiz Home OS

The Ortiz household's shared home manager — recurring upkeep, one-off chores,
the grocery list (with Costco-day nudges), vendors, and family appointments.
Third app in the Ortiz OS family, alongside
[Learning OS](https://ortizzle.github.io/deep-learning-os/) and
[Focus OS](https://ortizzle.github.io/ortiz-focus-os/).

**Stack:** vanilla HTML/CSS/JS, ES modules, no build step. Local-first
(IndexedDB) with shared private-Gist sync — both phones configure the same
token + Gist ID and merge (newest-updatedAt wins, tombstones keep deletions
deleted). Every record is stamped `by` the device that created it.

## Run locally

```
node .claude/serve.js   # serves on http://localhost:8125
```

## How it thinks

- **Upkeep** is the recurring backbone: interval + last-done → next-due.
- **Suggestions** are deterministic rules, not AI: errand day surfaces the
  grocery list, overdue upkeep floats up, dateless vendor chores get nagged.
- **Google Keep has no consumer API** — the grocery list lives here, with a
  paste-import bridge for lists voiced into Keep.
- v1.5: read-only Google Calendar overlay. v2: a Claude-powered advisor.
  See the suite ROADMAP in the ortiz-focus-os repo.

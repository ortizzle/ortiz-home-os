# Ortiz Home OS — kickoff

## Project

Build **Ortiz Home OS**, a shared household-management PWA for Chris and his wife — the third app in the Ortiz OS family (Learning OS, Focus OS). Same architecture as its sisters: static multi-file vanilla HTML/CSS/JS, ES modules via `<script type="module">`, no server, no build step, deployed to GitHub Pages at `ortizzle.github.io/ortiz-home-os/`.

The job: **capture everything it takes to run the house, know when it's due, and nudge at the moment there's actually time to act.** Filters get replaced on schedule, the new landscaper gets booked, the Costco list is in hand on Costco day, and family appointments don't sneak up on anyone.

## What's different from the sister apps (read this first)

Learning OS and Focus OS are single-user. Home OS is **two people, one dataset**, and that changes three things:

1. **Shared sync from day one.** Both phones configure the *same* private Gist + token (a gist has exactly one writer — its owner — so Chris's token lives on both devices; it's gist-scope only and this is a marriage, not a threat model). The existing store.js already handles multi-device merge: newest-`updatedAt` wins per record, tombstones prevent deletion resurrection. Two humans is just two devices.
2. **Attribution.** Every record carries a `by` field, set from a per-device display name in settings ("Chris" / device name). Who added the item, who logged the chore done. No accounts, no auth — the device is the identity.
3. **No streaks, no scores — not even the Focus OS streak.** A household app that scores spouses is a divorce app. Counts and due-dates only.

## v1 Scope (build these)

1. **Maintenance schedule** — the recurring backbone. Items like "Replace HVAC filter" with an interval (`every N days/months`), `lastDoneAt`, and a computed next-due. "Log done" resets the clock. Overdue and due-within-7-days float to the top of Home. This is the one place recurrence gets built (Focus OS deliberately skipped it; here it's the point).
2. **Household tasks** — one-off chores and to-dos ("call the landscaper back", "fix the gate latch"), with optional due date, assignee, and linked vendor. Flat list, same interaction grammar as Focus OS tasks.
3. **Grocery list** — fast add (the app owns the list; see the Keep reality check below), optional store tag (Costco / other), check-off with `gotAt`, and `addedBy`. Checked items stay visible for the day ("what we already grabbed"), then archive.
4. **Errand-day nudge (Costco day)** — configurable errand day(s), default **Saturday**. Within 24h of an errand day with open grocery items: the list takes over the top of Home, item count on the tab badge, and a notification on app open. This is the v1 version of "alert us the next time we go to Costco" — deterministic and reliable. Calendar-driven detection ("Costco" event) arrives in v1.5.
5. **Vendors & services** — lightweight directory: name, service type, phone/email, notes, last-used. Row actions: call (`tel:`), and "schedule" → creates an appointment or task pre-linked to the vendor. This is the "new landscaper" flow: add vendor → schedule first visit → it lands on the calendar.
6. **Appointments** — manually entered family appointments (doctor's office, school things) with date/time and who it's for. Day/week calendar views ported from Focus OS. Today's + tomorrow's appointments surface on Home. (Google Calendar read-overlay is v1.5 — see phases.)
7. **Household goals + suggestion rules** — a small `goals` store ("yard ready by May", "quarterly deep-clean") and a **deterministic** rule engine that turns state into Home-screen suggestions: overdue maintenance → "schedule it", errand day → grocery list, vendor with no follow-up in N days → "check in", goal with no linked activity → "plan a step". v1 smart = rules, not AI. It should feel attentive, not clever.
8. **Home dashboard** — the household's shared "today": due/overdue maintenance, today's chores + appointments, grocery status, active suggestions, quick capture (chore | grocery | appointment).

## Reality check: integrations (be honest in the build)

- **Google Keep has no consumer API.** The Keep API is Workspace-enterprise-only; a personal-account PWA cannot read those lists, and since Google retired third-party Assistant list providers (2023), "Hey Google, add milk" is locked to Keep. So v1 the app **owns** the grocery list, with two pressure valves: (a) an **import box** — open Keep, share/copy the list text, paste; the app parses lines into items, and (b) capture in-app is fast enough (installed-PWA shortcut) that the voice habit can migrate over time or coexist with a weekly paste. Revisit only if Google ever opens the API.
- **Google Calendar is the family's real calendar** (Family + personal calendars already exist). Read-only overlay via Google Identity Services browser OAuth (`calendar.readonly`, token stays on-device like the Gist token) is **v1.5, the first upgrade** — not v1, so the foundation ships fast. Requires a one-time free Google Cloud OAuth consent setup. Build it as a portable module: Focus OS gets the same overlay later.
- **Notifications, honestly.** No server means no true web push. v1: notification-on-open (fires when either phone opens the app, which on a Costco Saturday is exactly when it's useful) + everything surfaced loudly on Home. Installed Chrome-on-Android PWAs also allow best-effort periodic background sync — use it, don't rely on it. If real push ever proves necessary, the smallest honest path is a tiny relay (e.g. ntfy) — explicitly out of scope for v1.

## Phases

- **v1 — the foundation (build now):** everything in scope above. Shared Gist, rules-based nudges, manual appointments.
- **v1.5 — calendar-aware:** Google Calendar read overlay (pick calendars in settings); appointment entry mostly replaced by overlay; nudges get calendar triggers — event titled "Costco" → grocery surfacing; free weekend morning + overdue outdoor maintenance → "good window to schedule the landscaper."
- **v2 — the advisor (decide later):** the "make suggestions from our goals and push us" layer, powered by Claude. Two candidate shapes, both with precedent: in-app calls with an API key (Learning OS pattern) doing a weekly household review, or a scheduled Claude routine that reads the synced snapshot + calendars and emails a morning digest. Choose after living with v1.5's rule engine — it may get 80% of the way there.

## Out of scope for v1 (do not build)

Budgeting/expense tracking, home inventory, document/photo storage, meal planning, smart-home device control (this is not a Google Home controller), natural-language capture, month calendar view, write-access to Google Calendar, AI features (v2 decision), more than one household. Leave clean extension points; don't build ahead of need.

## Architecture

```
ortiz-home-os/
├── index.html          # shell + view containers
├── styles.css          # port the token system; family visual language
├── app.js              # router, theme, settings (device name, errand days, Gist), boot
├── modules/
│   ├── store.js        # PORT WHOLESALE from Focus OS — tombstones included; namespaced ohos.*, DB 'ortiz-home-os'
│   ├── ui.js           # port from Focus OS (el/toast/openModal/date helpers)
│   ├── maintenance.js  # recurring items, intervals, log-done, next-due
│   ├── chores.js       # one-off tasks + vendor links
│   ├── grocery.js      # list, check-off, Keep paste-import parser
│   ├── vendors.js      # directory + call/schedule actions
│   ├── calendar.js     # day/week views (port from Focus OS), appointments
│   ├── suggest.js      # deterministic rule engine → Home suggestions
│   └── dashboard.js    # Home: household today + nudges + quick capture
├── manifest.json
└── sw.js               # network-first-with-revalidate (same as sisters — cache-first caused the stuck-update bug)
```

## Data layer

Port `store.js` unchanged in mechanism. All records carry `id`, `createdAt`, `updatedAt`, plus `by` (device display name). Snapshot versioned `{ schemaVersion: 1, data }`. Stores:

- `maintenance`: { title, intervalDays, lastDoneAt?, seedDue?, notes?, vendorId? } — nextDue computed, never stored
- `chores`: { title, dueDate?, assignee?, vendorId?, done, doneAt?, notes? }
- `groceries`: { name, qty?, store?, gotAt?, addedBy }
- `vendors`: { name, service, phone?, email?, notes?, lastUsedAt? }
- `appointments`: { title, date, startTime?, endTime?, who?, location?, allDay }
- `goals`: { title, cadence?, notes? }
- `tombstones`: { store, recordId, deletedAt } — port as-is, non-negotiable
- settings (localStorage `ohos.settings`, per-device): deviceName, errandDays, theme/accent, gistToken/gistId

Dates: local `YYYY-MM-DD` strings only (never `toISOString()` for day-keyed data — the UTC-rollover lesson).

## Design

Family visual language: cool neutrals, accent picker, light/dark via tokens, Inter, crafted inline-SVG line icons only (no emoji — the Android rendering lesson). Mobile-first for two Android/Chrome phones ("Add to Home screen" language).

**Its own mark** — not the bulb (Learning), not the stopwatch (Focus). Suggest a simple gable-house outline in the same thin-rounded-stroke style, door as the negative space. Confirm with Chris before finalizing, same as last time.

## Workflow rules (standing)

Small commits, clear messages. Brief view-layout plan before large UI work. Surgical edits, never whole-file rewrites for small changes. Local test checklist after scaffold; verify in a real browser preview before declaring done. **New for this app:** every feature gets sanity-checked against "does this work when the *other* spouse's phone did it first?" — sync is the substrate, not a feature.

## First deliverable

Scaffold with working shell and four verified happy paths:

1. Add maintenance item "Replace HVAC filter — every 90 days," log it done → next-due appears on Home.
2. Add grocery items; set Saturday as errand day; on an errand day the list takes over Home top (test by toggling the setting to today).
3. Add vendor "landscaper" → schedule visit from the vendor row → appointment appears on the calendar day view.
4. Two-browser shared-Gist smoke test: add an item in browser A, sync, see it (with correct `by`) in browser B; delete in B, confirm it stays gone in A.

Then stop and let Chris and his wife test on both phones before wiring anything further.

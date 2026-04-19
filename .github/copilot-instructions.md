# Copilot instructions — subscription_pass_server

This repository is a small Node.js data-collection pipeline for Korean public housing subscription data. Use these notes to act as a productive coding assistant for maintenance, debugging and feature work.

- **Big picture:** a scheduled pipeline fetches public API data (odcloud), normalizes it, upserts into Supabase, then sends user notifications. Core flow: `src/scheduler.js` (cron) → `src/pipeline.js` (steps 1..6) → `src/controllers/*` (collectors) → `src/utils/*` (API / DB / logger) → `src/notifier.js` (FCM stub / logs).

- **Run & debug commands:**
  - Start scheduler: `npm start` (runs `node src/scheduler.js`).
  - Run full pipeline once: `npm run run:once` (runs `node src/pipeline.js`).
  - Test API client: `npm run test:api` (runs `node src/utils/apiClient.js`).
  - Import a single module for quick run (example):
    `node -e "import('./src/controllers/competitionRates.js').then(m => m.collectCompetitionRates())"`

- **Important env vars (.env):**
  - `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` — required. Process exits if missing (`src/utils/supabaseClient.js`).
  - `PUBLIC_DATA_API_KEY` (required), optional: `PUBLIC_DATA_API_KEY_CMPET`, `PUBLIC_DATA_API_KEY_STAT` (`src/utils/apiClient.js`).
  - `REQUEST_DELAY_MS`, `COLLECT_PAGE_SIZE`, `MAX_PAGES`, `RUN_ON_START` for throttling and startup behavior.

- **Data flow & ordering constraints (must preserve):**
  - `src/pipeline.js` describes exact sequence and why order matters: collect announcements → housing types → competition rates → update statuses → historical cutoffs → notifications. Do not reorder without checking comments and tests.
  - `updateAnnouncementStatuses()` prefers a DB `rpc('update_announcement_status')` and falls back to JS logic (`src/controllers/announcements.js`).

- **DB / upsert conventions:**
  - Use `batchUpsert(table, items, conflictColumn)` from `src/utils/supabaseClient.js` for safe upserts and chunking. Many controllers rely on specific `conflictColumn` values (e.g. `announcement_no`, composite keys like `announcement_id,type_name`). Ensure DB unique constraints match the `onConflict` keys.

- **API client patterns:**
  - `src/utils/apiClient.js` centralizes endpoints and key selection. Use `fetchAllPages()` to respect pagination and `DELAY_MS` to avoid rate limits.
  - Errors from odcloud can be 5xx or return empty arrays (especially before winner announcements); callers treat empty arrays as valid no-data responses (see `historicalCutoffs.js`).

- **Notification behavior:**
  - `src/notifier.js` reads `user_subscription_status` view to get `fcm_token` and `is_pro`. FCM sending is a stub — real integration requires adding `firebase-admin`. Keep notification logic idempotent: logs are stored in `notifications` table via `saveNotificationLog()`.

- **Conventions & patterns:**
  - Collector functions are named `collect*` and live under `src/controllers`.
  - Helpers live under `src/utils` (Supabase singleton, API client, logger). Logger is used throughout for info/debug/warn/error.
  - Cron expressions live in `src/scheduler.js`. Two active schedules: daily full run at `0 4 * * *` (KST) and hourly competition run at `0 * * * *` (KST).

- **Safety & secrets:**
  - `SUPABASE_SERVICE_KEY` is a service-level key (bypasses RLS). Treat it as highly sensitive; never log full keys; `apiClient.js` prints only prefixes in `test:api`.

- **Files to inspect for examples:**
  - `src/pipeline.js` — pipeline steps, error handling, finalization.
  - `src/scheduler.js` — cron setup and `RUN_ON_START` handling.
  - `src/utils/apiClient.js` — endpoints, pagination, key mapping.
  - `src/utils/supabaseClient.js` — `supabase`, `upsert`, `batchUpsert` helpers.
  - `src/notifier.js` — notification mapping and plan-based filtering.

If anything here is unclear or you'd like more detail (SQL schema expectations, sample `.env`, or recommended test harness), tell me which part to expand.

# World Cup 2026 — Prediction Game
## Complete Project Documentation

---

## Table of Contents
1. [Overview](#overview)
2. [Tech Stack](#tech-stack)
3. [File Structure](#file-structure)
4. [Database Schema](#database-schema)
5. [App Features](#app-features)
6. [Scoring Rules](#scoring-rules)
7. [Business Rules](#business-rules)
8. [Sync Mechanism](#sync-mechanism)
9. [Deployment](#deployment)
10. [Configuration](#configuration)
11. [Fixes & Changes Log](#fixes--changes-log)

---

## Overview

A lightweight, mobile-first football prediction game for a private group of 5–20 friends. Members predict the scoreline of each World Cup 2026 match and submit pre-tournament bonus picks (tournament winner, golden boot, golden glove). Points accumulate on a live leaderboard that updates automatically.

**Design goals:**
- Zero friction for end users — no password, no install, just type your name
- Zero ongoing cost — all free tiers
- Zero manual work during the tournament — fixtures and results sync automatically

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 (CDN), Babel Standalone (browser-side JSX) |
| Database / Backend | Supabase (PostgreSQL, free tier) |
| Auth | Name-only lookup against `members` table; session in `localStorage` |
| Styling | Pure CSS custom properties, no framework |
| Fixture / Result data | football-data.org API v4 (free tier) |
| Sync runner | Node.js 18+ script — zero npm dependencies |
| Sync scheduling | GitHub Actions (cron, every 30 minutes) |
| Hosting | Netlify Drop or Vercel (static file, no build step) |

---

## File Structure

```
PredictionGame/
├── index.html                        # The entire web app (single file)
├── server.js                         # Local dev HTTP server (port 3456)
├── supabase/
│   └── schema.sql                    # Full DB schema — run once in Supabase
├── sync/
│   └── sync.js                       # Pulls fixtures + results, runs scoring
├── .github/
│   └── workflows/
│       └── sync.yml                  # GitHub Actions — runs sync every 30 min
├── .env.example                      # Template for local env vars
├── .env                              # Real secrets (gitignored — never commit)
├── .claude/
│   └── launch.json                   # Local dev server config
└── README.md                         # Setup guide
```

### File Details

| File | Purpose |
|---|---|
| `index.html` | Self-contained React app. Contains all CSS, all component logic, and Supabase client config. No build step needed. |
| `server.js` | Minimal Node.js HTTP server for local previewing. Not used in production. |
| `supabase/schema.sql` | Defines all 5 tables, 2 triggers, `run_scoring()` function, `leaderboard` view, and all RLS policies. |
| `sync/sync.js` | Fetches all WC matches from football-data.org, upserts into Supabase, updates tournament start date, runs scoring. |
| `.github/workflows/sync.yml` | Runs `sync.js` on a `*/30 * * * *` cron. Also supports manual `workflow_dispatch`. |
| `.env.example` | Documents the 3 required env vars. Copy to `.env` and fill in for local runs. |
| `.env` | Live secrets — `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `FOOTBALL_DATA_TOKEN`. Never committed to git. |

---

## Database Schema

### Table: `settings`
Singleton config table (always exactly one row, `id = 1`).

| Column | Type | Default | Description |
|---|---|---|---|
| `id` | int | 1 | Primary key — constrained to always be 1 |
| `tournament_start_at` | timestamptz | null | Kickoff of the first match — locks bonus picks |
| `result_points` | int | 2 | Points for correct result (winner/draw) |
| `exact_points` | int | 10 | Points for exact scoreline |

### Table: `members`
| Column | Type | Description |
|---|---|---|
| `id` | uuid | Primary key, auto-generated |
| `name` | text | Unique, not null — used for login |
| `created_at` | timestamptz | Auto-set on insert |

### Table: `matches`
| Column | Type | Description |
|---|---|---|
| `id` | bigint | Primary key — football-data.org match ID |
| `stage` | text | GROUP_STAGE / LAST_16 / QUARTER_FINAL / etc. |
| `group_name` | text | Group_A / Group_B / etc. (null for knockouts) |
| `home_team` | text | Home team name |
| `away_team` | text | Away team name |
| `kickoff_at` | timestamptz | Match kickoff time (UTC) |
| `status` | text | SCHEDULED / IN_PLAY / FINISHED |
| `home_score` | int | Full-time home score (null until FINISHED) |
| `away_score` | int | Full-time away score (null until FINISHED) |
| `winner` | text | HOME / AWAY / DRAW — includes extra time & pens for knockouts |
| `is_knockout` | boolean | true for any non-group stage match |

### Table: `predictions`
| Column | Type | Description |
|---|---|---|
| `id` | uuid | Primary key, auto-generated |
| `member_id` | uuid | FK → members(id), cascade delete |
| `match_id` | bigint | FK → matches(id), cascade delete |
| `pred_home` | int | Predicted home score |
| `pred_away` | int | Predicted away score |
| `pred_winner` | text | HOME / AWAY / DRAW |
| `points` | int | Filled by scoring after the match (default 0) |
| `scored` | boolean | Set to true once scoring has run (default false) |
| `updated_at` | timestamptz | Updated on every change |

**Unique constraint:** `(member_id, match_id)` — one prediction per member per match.

### Table: `bonus_predictions`
| Column | Type | Description |
|---|---|---|
| `member_id` | uuid | Primary key + FK → members(id), cascade delete |
| `champion` | text | Predicted tournament winner (country name) |
| `golden_boot` | text | Predicted top scorer (player name) |
| `golden_glove` | text | Predicted best keeper (player name) |
| `updated_at` | timestamptz | Updated on every change |

One row per member. These picks are for individual prizes only — not counted in the leaderboard.

---

### Trigger: `enforce_prediction_window`
Fires BEFORE INSERT OR UPDATE on `predictions`.

**Logic:**
1. Resolves caller's JWT role. No JWT (direct SQL) = treated as `service_role`.
2. If UPDATE and only `points`/`scored` changed AND caller is `service_role` → allow (scoring bypass).
3. If `now() >= kickoff_at` or `status <> 'SCHEDULED'` → **block** ("match has started or finished").
4. If `kickoff_at > now() + 48 hours` → **block** ("only predict within the next 2 days").
5. Otherwise → sets `updated_at = now()` and allows.

**Security:** The scoring bypass is restricted to `service_role` only. Regular users (`anon`) cannot update `points` directly — the bypass never triggers for them.

---

### Trigger: `enforce_bonus_window`
Fires BEFORE INSERT OR UPDATE on `bonus_predictions`.

**Logic:**
- Reads `tournament_start_at` from settings.
- If set and `now() >= tournament_start_at` → **block** ("tournament has started — bonus picks are locked").

---

### Stored Function: `run_scoring()`
Called at the end of every sync run. Scores all finished matches.

```sql
-- Points awarded:
-- Exact scoreline (home AND away correct) → exact_points (default 10)
-- Correct result only                     → result_points (default 2)
-- Wrong result                            → 0
-- Exact does NOT stack with result points.
```

Sets `scored = true` on all updated rows. Runs as `SECURITY DEFINER` to bypass RLS.

---

### View: `leaderboard`
Joins `members` LEFT JOIN `predictions`. Returns one row per member.

| Column | Description |
|---|---|
| `id` | Member UUID |
| `name` | Member name |
| `total_points` | SUM of points (0 if no predictions) |
| `matches_played` | Count of predictions on finished/settled matches |
| `matches_scored` | Count of predictions that earned points (points > 0) |
| `exact_hits` | Count of exact scoreline hits |

**Sort order:** `total_points DESC` → `exact_hits DESC` → `name ASC`

---

### Row Level Security (RLS)

| Table | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `members` | ✅ | ❌ | ❌ | ❌ |
| `matches` | ✅ | ❌ | ❌ | ❌ |
| `settings` | ✅ | ❌ | ❌ | ❌ |
| `predictions` | ✅ | ✅ | ✅ | ❌ |
| `bonus_predictions` | ✅ | ✅ | ✅ | ❌ |
| `member_auth` | ❌ | ❌ | ❌ | ❌ |

Time-gating on writes is enforced by triggers, not RLS. RLS simply opens INSERT/UPDATE on predictions and bonus_predictions, and the triggers handle all validation.

### Authentication (Name + PIN)
- `member_auth (member_id, pin)` stores each member's private PIN. RLS is enabled with **no policies** and grants revoked, so the anon key **cannot read or write it at all**.
- Login goes through the `verify_login(p_name, p_pin)` function (`SECURITY DEFINER`): it joins `members` + `member_auth` and returns the matching member's `id` + `name` **only on a correct match** — it never returns or exposes the PIN.
- Kids get 2-digit PINs (stored with a leading zero, e.g. `042`); adults get 3-digit PINs. PINs are admin-assigned and shared privately. Real PIN values are **not** stored in `schema.sql`.

---

## App Features

### Login Screen
- **Name + PIN** inputs (PIN is numeric, max 3 digits, masked)
- Verified via the `verify_login(name, pin)` function (case-insensitive name); the PIN is never exposed to the client
- Session stored in `localStorage` as `wc_me_v2` — persists across browser closes (so the PIN is entered only once per device)
- Switching user (🔄) also requires the target's PIN → blocks impersonation
- Enter key supported; "Checking..." disabled state during fetch

### Header (all tabs)
- Gradient bar (blue → green) with title and current user's name
- Name chip shows `🔄` icon — clicking prompts "Switch user?" confirmation
- Switching user clears `localStorage` and returns to login

---

### Tab: Predict (📝)
Shows matches that are:
- `SCHEDULED` AND kick off within the next 48 hours, **or**
- Live — `IN_PLAY`, or any non-`FINISHED` match whose kickoff time has passed (covers the gap before sync flips status to IN_PLAY)

**Info banner** at the top:
- ⏱ Open until match kickoff
- 🎯 Exact score = 10 pts (gold)
- ✅ Correct result = 2 pts (green)

**Match Card — Open match:**
- Group/stage label and kickoff time
- Two numeric score inputs (digits only, max 2 digits, numeric keyboard on mobile)
- For knockout matches where predicted score is a draw → "X goes through / Y goes through" buttons appear (required for save)
- For group stage draws → `pred_winner` auto-set to `DRAW` (no extra UI)
- Save button disabled until all fields are valid
- On save: upserts prediction, button switches to "Update prediction" immediately
- "✓ Saved" / "⚠ error" message shown for 2.5 seconds

**Match Card — Live match (IN_PLAY, or kicked off but not yet FINISHED):**
- 🔴 **LIVE** badge in red (replaces kickoff time)
- Inputs disabled, save button hidden
- Shows user's existing prediction if made: "Your prediction: X – Y"
- Shows "No prediction submitted" in red if no prediction was made
- Card has reduced opacity (locked appearance)

---

### Tab: Matches (📅)
Shows all 104 World Cup matches ordered by kickoff, grouped by day with date headers.

For each match:
- Group/stage label
- Kickoff time / "FT" (if finished) / inferred live indicator
- Score: `X : Y` when FINISHED, `– : –` otherwise
- User's prediction with points once scored:
  - 🥇 Gold — exact scoreline (10 pts)
  - 🟢 Green — correct result (2 pts)
  - Grey — wrong or unscored (0 pts)

---

### Tab: Bonus (🏆)
Three free-text inputs:
- 🏆 Tournament winner (country name)
- 👟 Golden Boot — top scorer (player name)
- 🧤 Golden Glove — best keeper (player name)

**Locking:** Reads `tournament_start_at` from `settings`. Locks when `now() >= tournament_start_at`. Shows lock deadline when open; lock message when closed.

**Button:** "Save picks" on first save, "Update picks" thereafter.

These picks are **prizes only** — not counted in the leaderboard. Check winners at end of tournament:
```sql
select m.name, b.champion, b.golden_boot, b.golden_glove
from bonus_predictions b join members m on m.id = b.member_id;
```

---

### Tab: Leaderboard (📊)
- Reads `leaderboard` view — one row per member
- Ranks: 🥇 🥈 🥉 then numbers
- Sub-stats per member (shown as "Played · Scored · Exact"):
  - **Played** count — matches settled so far (grey, informational)
  - **Scored** count — predictions that earned points (points > 0) — green when > 0, grey when 0
  - **Exact** count — exact scoreline hits — gold when > 0, grey when 0
- Current user's row highlighted with green-tinted background
- Total points shown prominently on the right

---

## Scoring Rules

| Outcome | Points |
|---|---|
| Exact scoreline (both home and away correct) | **10 pts** |
| Correct result only (right winner or draw, wrong score) | **2 pts** |
| Wrong result | **0 pts** |

- Exact score does **not** stack with result points — 10 pts is the flat reward
- For knockout matches, the result is who **advances** (including extra time and penalties)
- Points are applied automatically by `run_scoring()` after each sync run
- `scored = true` is set alongside `points`, so unscored and 0-point predictions are distinguishable
- Point values are configurable: `update settings set result_points=2, exact_points=10;`

---

## Business Rules

### Database-enforced (cannot be bypassed by UI or API)

| # | Rule | Where Enforced |
|---|---|---|
| 1 | Predictions locked once match has started or status ≠ SCHEDULED | `enforce_prediction_window` trigger |
| 2 | Predictions only allowed for matches within the next 48 hours | `enforce_prediction_window` trigger |
| 3 | Scoring can update points/scored on finished matches (service role only) | `enforce_prediction_window` trigger (bypass) |
| 4 | Bonus picks lock when `tournament_start_at` is reached | `enforce_bonus_window` trigger |
| 5 | One prediction per member per match | UNIQUE constraint `(member_id, match_id)` |
| 6 | One bonus row per member | `member_id` is PRIMARY KEY on `bonus_predictions` |
| 7 | Settings always has exactly one row | CHECK constraint `id = 1` |
| 8 | Deleting a member removes their predictions and bonus picks | CASCADE on FK |
| 9 | Anon key cannot write to `members`, `matches`, or `settings` | RLS policies |

### UI-enforced (client-side — can be bypassed by direct API calls)

| # | Rule |
|---|---|
| 10 | Predict tab only shows matches within 48h or IN_PLAY |
| 11 | Knockout draw requires team selection before save is enabled |
| 12 | Save button disabled during in-flight requests (prevents double-submit) |
| 13 | Score inputs accept digits only, max 2 characters |
| 14 | Live match inputs are disabled |
| 15 | Bonus inputs disabled when tournament has started |
| 16 | Login requires name to match a `members` row (case-insensitive) |

---

## Sync Mechanism

**Source:** football-data.org API v4
**Endpoint:** `GET https://api.football-data.org/v4/competitions/WC/matches`
**Auth:** `X-Auth-Token` header
**Trigger:** GitHub Actions cron `*/30 * * * *` or manual `workflow_dispatch`

### Sync Steps (`sync/sync.js`)

1. **Fetch** — One API call gets all 104 World Cup matches
2. **Map** — Transforms API response to `matches` table shape:
   - Status: `IN_PLAY/PAUSED → IN_PLAY`, `FINISHED → FINISHED`, else `SCHEDULED`
   - Winner: `HOME_TEAM → HOME`, `AWAY_TEAM → AWAY`, `DRAW → DRAW`, else null
   - `is_knockout`: true when `stage !== 'GROUP_STAGE'`
   - Scores: only populated when FINISHED
3. **Upsert** — Posts all rows with `resolution=merge-duplicates` (upsert on `id`)
4. **Update settings** — Sets `tournament_start_at` to earliest `kickoff_at` found
5. **Score** — Calls `rpc/run_scoring` to apply points to all finished matches

**Requirements:** Node.js 18+, no npm packages (uses built-in `fetch`)
**Rate limits:** Free tier allows 10 calls/min; sync uses 1 call per run

### Running Locally
```bash
# Copy and fill in .env
cp .env.example .env

# Run sync
node sync/sync.js
```

---

## Deployment

### Web App (index.html)
The app is a single static HTML file — no build step, no package.json.

**Steps:**
1. Fill in Supabase URL and anon key at the top of the script block in `index.html`
2. Drag only `index.html` (not the whole folder) onto https://app.netlify.com/drop

> ⚠️ **Never deploy the full folder** — it contains `.env` with the secret key. Deploy `index.html` only.

**Local preview:**
```bash
node server.js
# Open http://localhost:3456
```

### Auto Sync (GitHub Actions)
1. Push project to a GitHub repo
2. Add 3 repository secrets (Settings → Secrets → Actions):
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY`
   - `FOOTBALL_DATA_TOKEN`
3. Go to Actions tab → "Sync World Cup results" → Run workflow (loads initial fixtures)
4. Cron runs automatically every 30 minutes from then on

### Cost
| Service | Cost |
|---|---|
| Supabase | Free |
| GitHub Actions | Free |
| Netlify / Vercel | Free |
| football-data.org | Free |
| **Total** | **$0** |

---

## Configuration

### Change scoring points
```sql
update settings set result_points = 2, exact_points = 10 where id = 1;
```

### Add a member
```sql
insert into members (name) values ('NewName');
```

### Manually lock / unlock bonus picks
```sql
-- Lock now
update settings set tournament_start_at = now() where id = 1;

-- Unlock (set to future date)
update settings set tournament_start_at = '2026-06-11 17:00:00+00' where id = 1;
```

### Check bonus prize winners at end of tournament
```sql
select m.name, b.champion, b.golden_boot, b.golden_glove
from bonus_predictions b join members m on m.id = b.member_id;
```

---

## Engagement Features

These were added after launch to keep the family group active, especially given the timezone (most matches kick off after midnight locally, so people engage in the morning).

### ☀️ Daily Recap (top of Predict tab)
A `Recap` component summarising "last night". Window = matches `FINISHED` with kickoff in the last ~30h.
- 🏁 **Results** — up to 6 matches, then "＋N more matches"
- 🎯 **Nailed it** — exact scorers; "sharpshooters! 🔥" (plural) / "bang on! 👌" (single). Hidden if nobody hit an exact (Top earner carries it)
- 🏆 **Top earner** — most points gained that night (independent of exacts)
- 🦁 **Boldest** — widest goal-margin pick (≥ 2); dynamic reaction: flop → "…ouch 😬", correct result → "paid off! 👏", exact → "NAILED it! 🤯🔥"
- 🦆 **Ducks - 0 pts** — predicted but scored 0; ≤4 names, else "N players", and "— brutal night! 😵" when > 8
- Auto-hides entirely when no matches finished recently

### 👥 Crowd Picks (Matches tab)
A collapsible `CrowdPicks` section per match card showing everyone's predictions.
- **Centered "👥 See/Hide N picks" toggle**, collapsed by default (keeps the page light)
- **Two-column grid** — even ~20 players fit in ~10 rows, no inner scroll
- **Sort:** leaderboard rank before kickoff → points earned after finish
- **"(you)" highlight**, **👑 leader marker**, and points colour-coding (🥇 exact / 🟢 result / grey) once finished
- **Controlled by two config constants:**
  - `REVEAL_MODE` — `'always'` (show as soon as predicted), `'after_kickoff'` (reveal only once locked), `'off'` (never show)
  - `CROWD_WINDOW_H` — only matches within ±this many hours of now show the picks list (default 50)
- Trade-off: in `'always'` mode, picks are visible before kickoff (copying is possible — acceptable for a trust-based family game; flip to `'after_kickoff'` if needed)

---

## Fixes & Changes Log

### `index.html`

| # | Fix | Description |
|---|---|---|
| 1 | Supabase config | Filled in Project URL and Publishable key |
| 2 | Save button state — Predict | Button switches to "Update prediction" immediately after save, no refresh needed |
| 3 | Group name display | Fixed "Group Group_A" → "Group A" (removed hardcoded prefix; underscore replaced with space) |
| 4 | Bonus picks lock source | Changed to read `tournament_start_at` from `settings` table instead of deriving from earliest match row — single source of truth |
| 5 | Logout icon | Replaced unsupported `⏻` power symbol with `🔄` (works on all mobile devices) |
| 6 | Login placeholder | Changed `e.g. Deepu` → `Your name here` |
| 7 | Predict info bar — wording | "Open until kickoff" → "Open until match kickoff" |
| 8 | Predict info bar — casing | `exact score` → `Exact score`, `correct result` → `Correct result` |
| 9 | Predict info bar — styling | Split into 3 separate lines with icons and colors, inside a styled card |
| 10 | Leaderboard — casing | `scored` → `Scored`, `exact` → `Exact` |
| 11 | Leaderboard — Scored color | Green when > 0, grey when 0 |
| 12 | Leaderboard — Exact color | Gold when > 0, grey when 0 |
| 13 | Save button state — Bonus | Button switches to "Update picks" immediately after save, no refresh needed |
| 14 | Live matches in Predict tab | IN_PLAY matches now shown as locked cards with 🔴 LIVE badge, disabled inputs, and prediction summary |
| 15 | Leaderboard — new "Played" stat | Added a "Played" count (matches settled). "Scored" was redefined to count only predictions that earned points (points > 0), so it no longer counts 0-point settled matches. Display is now "Played · Scored · Exact" |
| 16 | Live detection — sync gap robustness | `live` now also covers matches that have kicked off but aren't FINISHED (`status==='IN_PLAY' || (status!=='FINISHED' && isPast(kickoff))`), applied in both the Predict filter and MatchCard. Shows the LIVE tag immediately at kickoff without waiting up to 30 min for the next sync to flip status to IN_PLAY |
| 17 | **Daily Recap card** (engagement) | New `Recap` component at the top of the Predict tab — "☀️ Last Night's Damage". Shows matches finished in the last ~30h plus highlights: 🎯 Nailed it (exact scorers, "sharpshooters!/bang on!"), 🏆 Top earner (most points gained), 🦁 Boldest (widest-margin pick with dynamic reaction: …ouch 😬 / paid off 👏 / NAILED it 🤯🔥; only when margin ≥ 2), 🦆 Ducks - 0 pts (predicted but scored 0; "brutal night! 😵" when > 8). Auto-hides when no recent matches. See "Engagement Features" section. |
| 18 | **Crowd Picks** on Matches tab (engagement) | New `CrowdPicks` component — a centered, collapsible "👥 See/Hide N picks" toggle on each match card, showing everyone's predictions in a two-column grid. Sort: leaderboard rank before kickoff → points earned after finish. "(you)" highlight + 👑 leader marker + points colour-coding once finished. Gated by two config constants (see below). |
| 19 | Recap — full team names | Removed first-word truncation that broke multi-word countries (e.g. "South Korea" → "South"); Recap now shows full team names |
| 20 | **Name + PIN login** (anti-impersonation) | Login (and 🔄 switch user) now requires a private per-member PIN, verified via the `verify_login()` SECURITY DEFINER function against a locked-down `member_auth` table (anon key cannot read PINs). Kids get 2-digit PINs (leading zero), adults 3-digit. Session key bumped `wc_me` → `wc_me_v2` to force a one-time re-login for everyone. Tampered `bonus_predictions` were reset. |

#### Config constants (top of `index.html`)
```js
const REVEAL_MODE   = 'always';   // 'always' | 'after_kickoff' | 'off'
const CROWD_WINDOW_H = 50;          // show crowd picks only for matches within ±this many hours of now
```

### `supabase/schema.sql`

| # | Fix | Description |
|---|---|---|
| 1 | `enforce_prediction_window` — scoring bypass | Trigger allows `run_scoring()` to update `points`/`scored` on finished matches without being blocked by the time-window check |
| 2 | `enforce_prediction_window` — service role check | Bypass restricted to `service_role` JWT only; `anon` users cannot inflate their own points |
| 3 | `enforce_prediction_window` — JWT null handling | Used `coalesce(nullif(...), 'service_role')` to safely handle missing JWT context (direct SQL editor) without a cast error |
| 4 | `leaderboard` view — Played/Scored split | Added `matches_played` (predictions on finished matches) and redefined `matches_scored` to `points > 0` (predictions that earned points). View must be dropped and recreated (`drop view` + `create view`) because column rename isn't allowed via `create or replace` |
| 5 | `member_auth` table + `verify_login()` | Added private PIN storage (RLS, no anon access, grants revoked) and a SECURITY DEFINER login function that returns a member only on a name+PIN match, never the PIN. Real PIN values loaded separately (kept out of the repo) |

---

*Last updated: June 2026*

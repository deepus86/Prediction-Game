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
| Fixture data + IDs | football-data.org API v4 (free tier) — also fallback scores |
| Timely scores | ESPN public scoreboard (free, no key) |
| Sync runner | Node.js 18+ script — zero npm dependencies |
| Sync scheduling | GitHub Actions (cron, every 30 minutes) |
| Hosting | Netlify Drop or Vercel (static file, no build step) |

---

## File Structure

```
PredictionGame/
├── index.html                        # The entire web app (single file)
├── _headers                          # Netlify: no-cache on HTML (deployed alongside index.html)
├── server.js                         # Local dev HTTP server (port 3456)
├── recap-test.html                   # Local Recap test harness (gitignored)
├── deploy/                           # Throwaway drag-drop bundle: index.html + _headers (gitignored)
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
| `sync/sync.js` | Fetches fixtures from football-data.org + timely scores from ESPN, merges (never clobbers/regresses; freezes settled finals), upserts into Supabase, updates tournament start date, runs scoring. See [Sync Mechanism](#sync-mechanism). |
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
| `tournament_start_at` | timestamptz | null | Kickoff of the first match (set by sync) |
| `bonus_lock_at` | timestamptz | null | When bonus **editing** closes; null → falls back to `tournament_start_at` |
| `bonus_reveal_at` | timestamptz | null | When everyone's bonus picks become **visible**; null → `bonus_lock_at` → `tournament_start_at` |
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

Two data sources, by design (see "Why two sources" below):

| Source | Role | Endpoint / Auth |
|---|---|---|
| **football-data.org** API v4 | Fixtures, kickoff times, stable match IDs, groups/stages, **fallback** scores | `GET /v4/competitions/WC/matches` · `X-Auth-Token` header |
| **ESPN** public scoreboard (free, no key) | **Timely** score line + winner + status | `GET site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=YYYYMMDD` |

**Trigger:** GitHub Actions cron `*/30 * * * *` or manual `workflow_dispatch`

### Why two sources (important context)
football-data.org's **free tier marks matches `FINISHED` quickly but delays the score line / winner for hours** — and its feed *flaps* (cached responses briefly report a finished match as `TIMED`/scheduled again). During the first WC match this left results blank. ESPN's public scoreboard publishes the final score at full-time, so it became the timely score source. football-data stays the **schedule/ID backbone and a stable fallback** — if ESPN's unofficial endpoint ever changes, scores still arrive (late) via football-data. (Verified empirically: football-data returned finished matches with `score: null`, while ESPN already had the correct `2–0`. A historical check showed football-data *does* return scores eventually — 380/380 past Premier League matches — confirming it's a lag, not a coverage gap.)

### Sync Steps (`sync/sync.js`)

1. **Fetch fixtures** — one football-data call gets all 104 matches.
2. **Read current DB state** — `GET matches?select=id,status,home_score,away_score,winner` so we can merge instead of clobber.
3. **Shape rows (merge against DB)** — for each match:
   - Status uses `forwardStatus()` — only ever advances `SCHEDULED → IN_PLAY → FINISHED`, never backwards (defeats the cached-`TIMED` flap).
   - Score/winner: take football-data's value **only if non-null**, else keep what's already stored (`null` never overwrites a known score; a manual DB entry survives).
3b. **Enrich with ESPN** (`applyEspnScores`, wrapped in try/catch so a failure can't break the sync):
   - Selects matches that **aren't a "settled final"** (settled = already `FINISHED` *with* a score in the DB → **frozen**, never touched again) and kicked off within the last ~4 days.
   - ESPN buckets by **US-Eastern day**, so for each match it queries the UTC date **and the previous day** to cover the midnight boundary.
   - Matches ESPN events to fixtures by **exact kickoff minute**, disambiguating simultaneous kickoffs by **team name** (normalized; `NAME_ALIASES` maps spelling divergences, e.g. ESPN "South Korea" ↔ football-data "Korea Republic"). Unmatched names are logged with a hint to add an alias.
   - On an ESPN `post` (final): writes score + winner + `FINISHED`. On `in` (live): advances status to `IN_PLAY` only.
4. **Upsert** — posts all rows with `resolution=merge-duplicates` (upsert on `id`).
5. **Update settings** — sets `tournament_start_at` to earliest `kickoff_at` found.
6. **Score** — calls `rpc/run_scoring` to apply points to all finished matches.

**Log line to watch:** `Status → FINISHED: N, with score line: M.` plus `ESPN: filled X final score(s)…`. If `with score line` stays `0` after a match ends, ESPN didn't match (check for an `ESPN: kickoff matched but names didn't…` warning → add a `NAME_ALIASES` entry).

**Module note:** `main()` runs only when invoked directly (`require.main === module`); the file also `module.exports`s `applyEspnScores`/`forwardStatus`/`canon`/`normName` for testing without DB writes.

**Requirements:** Node.js 18+, no npm packages (uses built-in `fetch`)
**Rate limits:** football-data free tier 10 calls/min — sync uses 1; ESPN adds 1–2 calls/run, no key/limit signup.

> This `sync/sync.js` is **identical in both instances** (family `Prediction-Game` and office `Digitz_PredictionGame`) — it's fully env-var driven, no per-group code. Keep them in sync when changing either.

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
2. Regenerate the clean bundle: copy `index.html` and `_headers` into a `deploy/` folder
   (`mkdir -p deploy && cp index.html _headers deploy/`)
3. Drag the **`deploy/` folder** onto https://app.netlify.com/drop

> ⚠️ **Never deploy the full project folder** — it contains `.env` with the secret key.
> Deploy the `deploy/` bundle (just `index.html` + `_headers`).

**`_headers` (caching):** sets `Cache-Control: no-cache` on the HTML so a redeploy shows up
without anyone needing a hard refresh. It must sit at the site root, which is why we deploy the
`deploy/` bundle (a single-file drag can't include it). The login session lives in `localStorage`
and is unaffected by this header. The `deploy/` folder is gitignored (throwaway, regenerated each deploy).

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
| ESPN scoreboard | Free (public, no key) |
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

### Control bonus editing & reveal (two separate dates)
`bonus_lock_at` controls when **editing** closes; `bonus_reveal_at` controls when **everyone's picks become visible**. Both fall back to `tournament_start_at` if null.
```sql
-- Reveal everyone's picks at Round of 32 kickoff (editing still locks at tournament start)
update settings set bonus_reveal_at = '2026-06-28T19:00:00+00' where id = 1;

-- Surprise: reopen editing until a later date, holding the reveal until then (no copying)
update settings set bonus_lock_at   = '2026-06-28T19:00:00+00',
                    bonus_reveal_at = '2026-06-28T19:00:00+00' where id = 1;

-- Lock editing now / unlock to a future date
update settings set bonus_lock_at = now() where id = 1;
update settings set bonus_lock_at = '2026-06-11 17:00:00+00' where id = 1;
```
> Rule of thumb: keep **`bonus_reveal_at` ≥ `bonus_lock_at`** so picks are never revealed while editing is still open.

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
  - `REVEAL_MODE` — `'always'` (show as soon as predicted), `'after_kickoff'` (reveal only once locked), `'off'` (never show). **Current: `'after_kickoff'`**
  - `CROWD_WINDOW_H` — only matches within ±this many hours of now show the picks list (default 50)
- **`after_kickoff` behaviour:** before kickoff the card shows **"👥 N predicted"** → just the *names* of who's locked in a pick (sorted by rank) + "🔒 Scores reveal at kickoff"; the actual scores appear only once the match locks. Scores for unlocked matches are **not fetched** to the client (the app queries only `member_id`), so picks can't be peeked via devtools. (A direct anon-key API call could still read them — same trust model as the rest of the app — but the app never hands over pre-kickoff scores.)
- Trade-off: in `'always'` mode, picks are visible before kickoff (copying is possible — fine for a trust-based family game); `'after_kickoff'` avoids that while still showing participation.

### 🎁 Bonus Picks Reveal (Bonus tab)
An "👥 Everyone's picks" card under the bonus pick form, governed by two separate dates in `settings`:
- **`bonus_lock_at`** — when editing closes (fallback: `tournament_start_at`)
- **`bonus_reveal_at`** — when everyone's picks become visible (fallback: `bonus_lock_at` → `tournament_start_at`)
- **Before reveal:** teaser — "N of M have locked in their picks" + who's done / still to pick + "🔒 reveal …". Pick *values* are **not fetched** to the client (only `member_id`), so they can't be peeked.
- **After reveal:** full list — `Name — 🏆 Champion · 👟 Boot · 🧤 Glove`, your row highlighted, blanks show "—".
- **Why two dates:** lets the admin lock editing at tournament start but **hold the reveal until later** (e.g. Round of 32), or run a "surprise reopen" of editing — keeping `bonus_reveal_at ≥ bonus_lock_at` avoids copying.
- *(Future option):* record the actual champion/boot/glove to auto-tick correct picks (✅/❌) at tournament end.

---

## Future Idea: Multi-League (Option 2) — Design Notes

> **Status: not built.** This is a captured design discussion for if/when we want to support
> multiple independent groups (e.g. another family or an office team) on **one** deployment.
> The current family game is single-group and should be left untouched — any build of this
> should happen on a **separate Supabase project**, never on the live family DB.

### Ways to run more groups (the spectrum)
| Option | Effort | Cost | When |
|--------|--------|------|------|
| **1. Clone** — each group runs its own copy (own Supabase + own deploy) | ~20 min | $0 (free tiers) | One extra group, simplest, **recommended first step** |
| **2. Multi-league** — one site, many groups partitioned by `league_id` | ~1–2 days end-to-end (coding is hours; rest is review/test/deploy) | ~$0 small scale | Several groups, run as one thing |
| **3. Public SaaS** — anyone signs up & creates groups | Weeks | ~$25–75/mo+ at scale | Only if turning it into a product |

### Multi-league model (admin-controlled, **no public self-create/join**)
- Add a `leagues` table; tag `members` / `predictions` / `bonus_predictions` / `settings` with `league_id`.
- **`matches` stays global** — one sync serves all leagues; scoring uses shared matches + each league's predictions.
- Scope all queries (predict, leaderboard, recap, crowd, bonus, settings) by the logged-in member's league.
- **Membership is admin-controlled** (mirrors today): members are pre-added, so nobody self-joins and nobody can spawn a league.

### Roles
- **Operator (you):** creates leagues, appoints commissioners.
- **Per-league commissioner:** an `is_admin` flag on members; only admins see "Add members". Lets you delegate roster management per group so you're not the bottleneck.

### PIN setup in the commissioner model
- **Chosen approach:** commissioner adds members (names + kid flags) → app **auto-generates** unique PINs (2-digit kids / 3-digit adults) → commissioner DMs them privately. Optionally add a **"change my PIN"** screen so members can set a private one afterwards.
- **Security requirement:** writing `member_auth` from the app must go through an **admin-only `SECURITY DEFINER` function** that **re-verifies the commissioner's name+PIN** (the only path that can create members/PINs). Anyone can call it, but without valid admin creds it does nothing.
- If self-serve admin gets heavy, **Supabase Auth (real login) for commissioners** (members stay on name+PIN) is the cleaner long-term foundation.

### Member journey (recommended: pre-add, no join step)
1. Operator creates a league + appoints a commissioner.
2. Commissioner adds their members; app generates PINs; commissioner DMs them.
3. Members log in with **name + PIN** → land directly in **their** league.
4. No join step — members never choose/create a league.

*(Optional self-join, not needed: commissioner shares a league code → member enters it once → tied to that league.)*

### Cross-project working & memory notes
- The family game and any Option-2 build are **separate folders + separate Supabase projects**; switching = point the tools at the other folder and use that project's keys. Fully isolated.
- A new project/session does **not** automatically remember chat history — durable context lives in **files like this one**. Carry the relevant `DOCS.md` sections into any new project so future sessions have the reasoning.

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
| 21 | `after_kickoff` — reveal *who*, hide *scores* | In `after_kickoff` mode, in-window matches now show a pre-kickoff teaser: **"👥 N predicted"** → names only (sorted by rank) + "🔒 Scores reveal at kickoff". Full picks appear once the match locks. Crucially, scores for not-yet-locked matches are **not fetched** to the client (the app queries only `member_id`), so picks can't be peeked via devtools. `CrowdPicks` takes a `revealScores` prop; `Results` splits the crowd fetch into full vs who-only by lock state. |
| 22 | **Bonus Picks Reveal** + two-date control | New "👥 Everyone's picks" card in the Bonus tab (teaser before reveal → full list after). `Bonus` now reads `bonus_lock_at` / `bonus_reveal_at` from settings (with fallbacks), so editing-lock and reveal are **independently configurable** (enables holding the reveal to Round of 32, or a surprise editing reopen). Pre-reveal fetch is who-only (no pick values sent to client). |

#### Config constants (top of `index.html`)
```js
const REVEAL_MODE   = 'after_kickoff';  // 'always' | 'after_kickoff' | 'off'
const CROWD_WINDOW_H = 50;               // show crowd picks only for matches within ±this many hours of now
```

### `supabase/schema.sql`

| # | Fix | Description |
|---|---|---|
| 1 | `enforce_prediction_window` — scoring bypass | Trigger allows `run_scoring()` to update `points`/`scored` on finished matches without being blocked by the time-window check |
| 2 | `enforce_prediction_window` — service role check | Bypass restricted to `service_role` JWT only; `anon` users cannot inflate their own points |
| 3 | `enforce_prediction_window` — JWT null handling | Used `coalesce(nullif(...), 'service_role')` to safely handle missing JWT context (direct SQL editor) without a cast error |
| 4 | `leaderboard` view — Played/Scored split | Added `matches_played` (predictions on finished matches) and redefined `matches_scored` to `points > 0` (predictions that earned points). View must be dropped and recreated (`drop view` + `create view`) because column rename isn't allowed via `create or replace` |
| 5 | `member_auth` table + `verify_login()` | Added private PIN storage (RLS, no anon access, grants revoked) and a SECURITY DEFINER login function that returns a member only on a name+PIN match, never the PIN. Real PIN values loaded separately (kept out of the repo) |
| 6 | `settings.bonus_lock_at` / `bonus_reveal_at` + trigger | Added two nullable columns to decouple bonus editing-lock from reveal. `enforce_bonus_window()` now locks at `coalesce(bonus_lock_at, tournament_start_at)`. Both default to null → unchanged behaviour until set |

---

*Last updated: June 2026*

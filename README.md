# ⚽ World Cup 2026 — Prediction Game

A mobile-first prediction game for a group of 5–20 friends. Members predict the
result and exact scoreline of each match, plus pre-tournament bonus picks. Scores,
fixtures, and results sync automatically. Free to run.

## How scoring works
- **Exact scoreline → 10 points** (does not stack with the result point)
- **Correct result (winner/draw) → 2 points**
- Knockouts: prediction resolves on **who advances** (including extra time / penalties)

## Special prizes (bonus picks)
Before the tournament starts, members pick the Tournament Winner, Golden Boot, and Golden Glove.
These are **not worth points** — correct picks win individual prizes, separate from the main leaderboard.
All three picks lock the moment the first match kicks off.

## What's enforced automatically
- You can only predict matches kicking off **within the next 2 days**.
- Once a match kicks off it's **locked** — past results can't be edited.
- Bonus picks lock the moment the **first match** kicks off.

All three rules are enforced in the database, so they hold no matter what.

---

## Setup (about 20 minutes, one time)

### 1. Create the database (Supabase — free)
1. Go to https://supabase.com → sign up → **New project**. Pick a name and a region near you.
2. When it's ready, open **SQL Editor → New query**, paste the entire contents of
   `supabase/schema.sql`, and click **Run**.
3. Open **Project Settings → API Keys** and copy two values:
   - **Project URL**
   - **Publishable key** (safe to paste into the web app)
   - (also note the **Secret key** — needed in step 3, never share this)

### 2. Add members
In **SQL Editor**, run (edit the values):
```sql
insert into members (name) values
  ('Deepu'), ('Alex'), ('Sam'), ('Priya');   -- add all 5–20 names
```

### 3. Turn on auto results sync (free)
This pulls fixtures and final scores automatically.
1. Get a free token at https://www.football-data.org/client/register
2. Put this project in a **GitHub repo**.
3. In the repo: **Settings → Secrets and variables → Actions → New repository secret**, add three:
   - `SUPABASE_URL` = your Project URL
   - `SUPABASE_SERVICE_KEY` = your Secret key
   - `FOOTBALL_DATA_TOKEN` = your football-data token
4. The included workflow (`.github/workflows/sync.yml`) now runs every 30 minutes.
   Run it once now from the **Actions** tab → *Sync World Cup results* → **Run workflow**
   to load all fixtures.

*Prefer to run it yourself instead of GitHub?* Copy `.env.example` to `.env`, fill it
in, and run `node sync/sync.js` anytime.

### 4. Publish the app
1. Open `index.html`, and at the top of the `<script>` config block paste your
   **Project URL** and **Publishable key**.
2. Deploy: drag the project folder onto https://app.netlify.com/drop **or** import the
   repo at https://vercel.com. You get a public link.
3. Share the link with your group. They open it on their phones, type their name
   once, and start predicting. Their session is saved — no login needed on return visits. 📲

---

## During the tournament
Nothing to do — fixtures open 2 days out, lock at kickoff, and results + the
leaderboard update themselves every 30 minutes.

## At the end (special prizes)
When the winner, top scorer, and best keeper are known, check who got each one right:
```sql
select m.name, b.champion, b.golden_boot, b.golden_glove
from bonus_predictions b join members m on m.id = b.member_id;
```
Award prizes to whoever matched. (Names must match the spelling members typed,
so consider agreeing on a list up front.)

## Tweaks
- **Change points:** `update settings set result_points=2, exact_points=10;`
- **Add a member late:** `insert into members (name) values ('NewName');`

## Files
| File | Purpose |
|------|---------|
| `index.html` | The whole app (React + Supabase, no build step) |
| `supabase/schema.sql` | Database tables, rules, scoring, leaderboard |
| `sync/sync.js` | Pulls fixtures + results, runs scoring |
| `.github/workflows/sync.yml` | Runs the sync every 30 min, free |
| `.env.example` | Env vars for running sync yourself |

## Notes & trade-offs
- Login is name only — frictionless for a group of friends. Session is saved in the browser
  so members don't need to log in again on return visits. Not identity-proof; for a public
  or competitive pool, switch to Supabase email auth.
- Free football-data.org tier allows 10 calls/min; the sync uses one call, well within limits.
- Bonus picks are free-text; agreeing on team/player spellings up front avoids mismatches.

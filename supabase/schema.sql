-- ============================================================
--  WORLD CUP 2026 PREDICTION GAME  —  DATABASE SCHEMA
--  Run this once in the Supabase SQL editor (SQL > New query).
-- ============================================================

-- ---------- 1. SETTINGS (single row of config) -------------
create table if not exists settings (
  id                    int primary key default 1,
  tournament_start_at   timestamptz,                 -- kickoff of the FIRST match; locks bonus picks
  result_points         int  not null default 2,     -- correct winner/draw
  exact_points          int  not null default 10,    -- exact scoreline (does NOT stack with result)
  constraint single_row check (id = 1)
);
insert into settings (id) values (1) on conflict (id) do nothing;

-- ---------- 2. MEMBERS (5-20 players) ----------------------
create table if not exists members (
  id         uuid primary key default gen_random_uuid(),
  name       text unique not null,
  created_at timestamptz default now()
);

-- ---------- 3. MATCHES (fixtures + results) ----------------
create table if not exists matches (
  id          bigint primary key,                  -- football-data.org match id
  stage       text,                                -- GROUP_STAGE / LAST_16 / etc.
  group_name  text,
  home_team   text not null,
  away_team   text not null,
  kickoff_at  timestamptz not null,
  status      text default 'SCHEDULED',            -- SCHEDULED / IN_PLAY / FINISHED
  home_score  int,                                 -- full-time (incl. extra time) once FINISHED
  away_score  int,
  winner      text,                                -- 'HOME' / 'AWAY' / 'DRAW' (knockouts: who advances incl. pens)
  is_knockout boolean default false
);

-- ---------- 4. PREDICTIONS (per member per match) ----------
create table if not exists predictions (
  id             uuid primary key default gen_random_uuid(),
  member_id      uuid not null references members(id) on delete cascade,
  match_id       bigint not null references matches(id) on delete cascade,
  pred_home      int not null,
  pred_away      int not null,
  pred_winner    text not null,                    -- 'HOME' / 'AWAY' / 'DRAW'
  points         int default 0,                    -- filled by scoring after the match
  scored         boolean default false,
  updated_at     timestamptz default now(),
  unique (member_id, match_id)
);

-- ---------- 5. BONUS PREDICTIONS (pre-tournament picks) ----
--  These are for individual prizes only — not worth leaderboard points.
create table if not exists bonus_predictions (
  member_id    uuid primary key references members(id) on delete cascade,
  champion     text,
  golden_boot  text,
  golden_glove text,
  updated_at   timestamptz default now()
);

-- ============================================================
--  RULE ENFORCEMENT (server-side — cannot be bypassed by UI)
-- ============================================================

-- Rule 7 + 8: a match prediction may only be created/edited when the
-- match has NOT started yet AND kicks off within the next 48 hours.
create or replace function enforce_prediction_window()
returns trigger language plpgsql as $$
declare ko timestamptz; st text; jwt_role text;
begin
  -- Resolve the caller's role (null = direct SQL, no JWT context)
  jwt_role := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::json->>'role',
    'service_role'   -- direct SQL editor has no JWT → treat as trusted
  );

  -- Allow scoring updates (points/scored only) from service role or direct SQL
  if (TG_OP = 'UPDATE' and
      new.pred_home = old.pred_home and
      new.pred_away = old.pred_away and
      new.pred_winner = old.pred_winner and
      jwt_role = 'service_role') then
    return new;
  end if;

  select kickoff_at, status into ko, st from matches where id = new.match_id;
  if ko is null then
    raise exception 'Unknown match';
  end if;
  if now() >= ko or st <> 'SCHEDULED' then
    raise exception 'This match has started or finished — predictions are locked.';
  end if;
  if ko > now() + interval '48 hours' then
    raise exception 'You can only predict matches kicking off within the next 2 days.';
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_prediction_window on predictions;
create trigger trg_prediction_window
  before insert or update on predictions
  for each row execute function enforce_prediction_window();

-- Bonus picks lock the moment the tournament starts.
create or replace function enforce_bonus_window()
returns trigger language plpgsql as $$
declare start_at timestamptz;
begin
  select tournament_start_at into start_at from settings where id = 1;
  if start_at is not null and now() >= start_at then
    raise exception 'The tournament has started — bonus picks are locked.';
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_bonus_window on bonus_predictions;
create trigger trg_bonus_window
  before insert or update on bonus_predictions
  for each row execute function enforce_bonus_window();

-- ============================================================
--  SCORING  (called by the sync job after results come in)
--  Only scores match predictions. Bonus picks are prizes,
--  not points, and are checked manually at tournament end.
-- ============================================================
create or replace function run_scoring()
returns void language plpgsql security definer as $$
declare rp int; ep int;
begin
  select result_points, exact_points into rp, ep from settings where id = 1;

  -- Match scoring: exact scoreline = exact_points (flat, no stacking);
  -- else correct winner/draw = result_points; else 0.
  update predictions p set
    points = case
      when m.home_score = p.pred_home and m.away_score = p.pred_away then ep
      when m.winner = p.pred_winner then rp
      else 0 end,
    scored = true
  from matches m
  where p.match_id = m.id
    and m.status = 'FINISHED'
    and m.home_score is not null;
end $$;

-- ============================================================
--  LEADERBOARD VIEW  (match points only)
-- ============================================================
drop view if exists leaderboard;
create view leaderboard as
select
  mb.id,
  mb.name,
  coalesce(sum(p.points), 0)                         as total_points,
  count(p.id) filter (where p.scored)                as matches_played,   -- predictions on finished matches
  count(p.id) filter (where p.points > 0)            as matches_scored,   -- predictions that earned points
  count(p.id) filter (where p.points = (select exact_points from settings where id=1)) as exact_hits
from members mb
left join predictions p on p.member_id = mb.id
group by mb.id, mb.name
order by total_points desc, exact_hits desc, mb.name asc;

-- ============================================================
--  ROW LEVEL SECURITY
--  anon key may: read everything, write only predictions/bonus
--  (time-gated by triggers above). It may NOT alter matches,
--  settings, or members.
-- ============================================================
alter table members            enable row level security;
alter table matches            enable row level security;
alter table predictions        enable row level security;
alter table bonus_predictions  enable row level security;
alter table settings           enable row level security;

create policy read_members  on members           for select using (true);
create policy read_matches  on matches           for select using (true);
create policy read_preds    on predictions       for select using (true);
create policy read_bonus    on bonus_predictions for select using (true);
create policy read_settings on settings         for select using (true);

create policy write_preds_ins on predictions for insert with check (true);
create policy write_preds_upd on predictions for update using (true) with check (true);
create policy write_bonus_ins on bonus_predictions for insert with check (true);
create policy write_bonus_upd on bonus_predictions for update using (true) with check (true);

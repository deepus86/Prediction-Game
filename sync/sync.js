// ============================================================
//  WORLD CUP 2026 — FIXTURE & RESULT SYNC
//  Pulls fixtures from football-data.org (the schedule/ID backbone) and
//  timely scores from ESPN's public scoreboard (football-data's free feed
//  delays score details for hours), writes them to Supabase, runs scoring.
//
//  Run manually:   node sync.js
//  Or on a schedule via the included GitHub Action (every 30 min).
//
//  Requires 3 environment variables (see .env.example):
//    SUPABASE_URL, SUPABASE_SERVICE_KEY, FOOTBALL_DATA_TOKEN
//  Node 18+ (uses built-in fetch). No npm install needed.
// ============================================================

const SUPABASE_URL   = process.env.SUPABASE_URL;
const SERVICE_KEY    = process.env.SUPABASE_SERVICE_KEY;
const FD_TOKEN       = process.env.FOOTBALL_DATA_TOKEN;

if (!SUPABASE_URL || !SERVICE_KEY || !FD_TOKEN) {
  console.error('Missing env vars. Need SUPABASE_URL, SUPABASE_SERVICE_KEY, FOOTBALL_DATA_TOKEN.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry transient network blips (dropped sockets, 5xx, 429) with backoff, so one
// flaky moment from football-data / ESPN / Supabase doesn't fail the whole run.
// 4xx (e.g. a bad token) is returned as-is — those aren't transient, don't retry.
async function fetchRetry(url, opts = {}, tries = 3) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, opts);
      if ((r.status >= 500 || r.status === 429) && i < tries) {
        console.warn(`HTTP ${r.status} from ${new URL(url).host} — retry ${i}/${tries - 1}`);
        await sleep(1500 * i);
        continue;
      }
      return r;
    } catch (e) {
      lastErr = e;
      if (i < tries) {
        console.warn(`fetch failed (${(e.cause && e.cause.code) || e.message}) from ${new URL(url).host} — retry ${i}/${tries - 1}`);
        await sleep(1500 * i);
        continue;
      }
    }
  }
  throw lastErr;
}

const sb = (path, opts = {}) =>
  fetchRetry(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });

const mapWinner = (w) =>
  w === 'HOME_TEAM' ? 'HOME' : w === 'AWAY_TEAM' ? 'AWAY' : w === 'DRAW' ? 'DRAW' : null;

const mapStatus = (s) =>
  s === 'FINISHED' ? 'FINISHED'
  : s === 'IN_PLAY' || s === 'PAUSED' ? 'IN_PLAY'
  : 'SCHEDULED';

// Status only ever moves forwards (SCHEDULED → IN_PLAY → FINISHED) so a
// cached/flapping feed response can't drag a match back to "scheduled".
const RANK = { SCHEDULED: 0, IN_PLAY: 1, FINISHED: 2 };
const forwardStatus = (oldS, newS) =>
  (RANK[newS] ?? 0) >= (RANK[oldS] ?? 0) ? newS : oldS;

// ---- ESPN (free, no key) — timely score source -------------------------
const ESPN_URL = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard';

// Normalize a country name to a comparable token (lowercase, no accents/punct).
const normName = (s) => (s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]/g, '');

// Known spelling divergences: ESPN-normalized → football-data-normalized.
// (Only needed to tell apart two matches kicking off at the same time; the
//  unmatched-name warning below tells us when to add a new entry.)
const NAME_ALIASES = {
  southkorea: 'korearepublic',
  unitedstates: 'usa',
  iran: 'iriran',
  czechrepublic: 'czechia',
  bosniaandherzegovina: 'bosniaherzegovina',
  ivorycoast: 'cotedivoire',
  turkey: 'turkiye',
};
const canon = (s) => { const n = normName(s); return NAME_ALIASES[n] || n; };

// Map an ESPN status state to ours.
const espnStatus = (state) =>
  state === 'post' ? 'FINISHED' : state === 'in' ? 'IN_PLAY' : 'SCHEDULED';

// Fill `rows` (already merged from football-data) with ESPN's timely scores.
// Mutates rows in place. Never touches a "settled final" (already FINISHED
// with a score in the DB) so results don't churn and manual fixes survive.
async function applyEspnScores(rows, have) {
  const now = Date.now();
  const need = rows.filter((r) => {
    const prev = have[r.id] || {};
    const settled = prev.status === 'FINISHED' && prev.home_score != null;
    const ko = Date.parse(r.kickoff_at);
    return !settled && ko <= now + 3600e3 && ko >= now - 4 * 24 * 3600e3;
  });
  if (!need.length) { console.log('ESPN: nothing to enrich.'); return; }

  // ESPN buckets matches by US-Eastern day (behind UTC), so for each match we
  // query its UTC date AND the previous day to cover the midnight boundary.
  const dates = new Set();
  for (const r of need) {
    const d = new Date(Date.parse(r.kickoff_at));
    for (const off of [0, -1]) {
      const dd = new Date(d.getTime() + off * 24 * 3600e3);
      dates.add(`${dd.getUTCFullYear()}${String(dd.getUTCMonth() + 1).padStart(2, '0')}${String(dd.getUTCDate()).padStart(2, '0')}`);
    }
  }

  // Pull each date once, pool the events (deduped by ESPN event id).
  const pool = new Map();
  for (const ds of dates) {
    const r = await fetchRetry(`${ESPN_URL}?dates=${ds}`);
    if (!r.ok) { console.warn('ESPN fetch failed', ds, r.status); continue; }
    const d = await r.json();
    for (const e of (d.events || [])) {
      const c = e.competitions?.[0]; if (!c) continue;
      const home = c.competitors?.find((x) => x.homeAway === 'home');
      const away = c.competitors?.find((x) => x.homeAway === 'away');
      if (!home || !away) continue;
      pool.set(e.id, {
        ko: Date.parse(e.date),
        state: c.status?.type?.state,
        home: canon(home.team?.displayName), away: canon(away.team?.displayName),
        hs: parseInt(home.score, 10), as: parseInt(away.score, 10),
        hw: !!home.winner, aw: !!away.winner,
        label: `${home.team?.displayName} ${home.score}-${away.score} ${away.team?.displayName}`,
      });
    }
  }

  // Index events by kickoff minute, then resolve each match by time + names.
  const byTime = new Map();
  for (const ev of pool.values()) {
    const k = Math.floor(ev.ko / 60000);
    if (!byTime.has(k)) byTime.set(k, []);
    byTime.get(k).push(ev);
  }

  let filled = 0;
  for (const r of need) {
    const cands = byTime.get(Math.floor(Date.parse(r.kickoff_at) / 60000)) || [];
    if (!cands.length) continue; // ESPN doesn't list this slot (yet)
    const rh = canon(r.home_team), ra = canon(r.away_team);
    let best = null, bestScore = -1;
    for (const ev of cands) {
      const s = (ev.home === rh ? 1 : 0) + (ev.away === ra ? 1 : 0);
      if (s > bestScore) { bestScore = s; best = ev; }
    }
    if (bestScore <= 0) {
      console.warn(`ESPN: kickoff matched but names didn't for "${r.home_team} v ${r.away_team}" (ESPN had: ${cands.map((c) => c.label).join(' | ')}). Consider a NAME_ALIASES entry.`);
      continue;
    }
    if (best.state === 'post' && Number.isInteger(best.hs) && Number.isInteger(best.as)) {
      r.home_score = best.hs;
      r.away_score = best.as;
      r.winner = best.hw ? 'HOME' : best.aw ? 'AWAY' : 'DRAW';
      r.status = forwardStatus(r.status, 'FINISHED');
      filled++;
    } else if (best.state === 'in') {
      r.status = forwardStatus(r.status, 'IN_PLAY');
    }
  }
  console.log(`ESPN: filled ${filled} final score(s) from ${pool.size} event(s) across ${dates.size} date(s).`);
}

async function main() {
  // 1. Fetch all World Cup matches.
  const res = await fetchRetry('https://api.football-data.org/v4/competitions/WC/matches', {
    headers: { 'X-Auth-Token': FD_TOKEN },
  });
  if (!res.ok) {
    console.error('football-data.org error', res.status, await res.text());
    process.exit(1);
  }
  const { matches } = await res.json();
  console.log(`Fetched ${matches.length} matches.`);

  // 2. Pull what we already have so we never regress good data.
  //    football-data's free feed flaps (cached TIMED responses) and delays
  //    score/winner details for hours, so we keep the furthest-along status
  //    and any score/winner we already know — including a manual entry.
  const cur = await sb('matches?select=id,status,home_score,away_score,winner');
  const have = {};
  if (cur.ok) { (await cur.json()).forEach((r) => { have[r.id] = r; }); }
  else { console.warn('Could not read existing matches; proceeding without merge.', cur.status); }

  // 3. Shape rows, merging against what we already have.
  const rows = matches.map((m) => {
    const ft = m.score?.fullTime || {};
    const prev = have[m.id] || {};
    return {
      id: m.id,
      stage: m.stage,
      group_name: m.group || null,
      home_team: m.homeTeam?.name || 'TBD',
      away_team: m.awayTeam?.name || 'TBD',
      kickoff_at: m.utcDate,
      status: forwardStatus(prev.status, mapStatus(m.status)),
      // Take the feed's score/winner only when it actually has one;
      // otherwise keep what we already stored (so null never clobbers).
      home_score: ft.home ?? prev.home_score ?? null,
      away_score: ft.away ?? prev.away_score ?? null,
      winner: mapWinner(m.score?.winner) ?? prev.winner ?? null,
      is_knockout: m.stage !== 'GROUP_STAGE',
    };
  });

  // 3b. Enrich with ESPN's timely scores (kept resilient — if ESPN is
  //     unreachable or changes, we still write football-data's data).
  try { await applyEspnScores(rows, have); }
  catch (e) { console.warn('ESPN enrichment skipped:', e.message); }

  const scoredCt = rows.filter((r) => r.home_score != null).length;
  const finishedCt = rows.filter((r) => r.status === 'FINISHED').length;
  console.log(`Status → FINISHED: ${finishedCt}, with score line: ${scoredCt}.`);

  // 4. Upsert fixtures + results.
  const up = await sb('matches?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!up.ok) { console.error('Upsert failed', up.status, await up.text()); process.exit(1); }
  console.log('Fixtures/results upserted.');

  // 5. Record tournament start (earliest kickoff) so bonus prize picks lock correctly.
  const firstKickoff = rows
    .map((r) => r.kickoff_at)
    .sort()[0];
  if (firstKickoff) {
    await sb('settings?id=eq.1', {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ tournament_start_at: firstKickoff }),
    });
  }

  // 6. Run match scoring.
  const sc = await sb('rpc/run_scoring', { method: 'POST', body: '{}' });
  if (!sc.ok) { console.error('Scoring failed', sc.status, await sc.text()); process.exit(1); }
  console.log('Scoring complete. Done.');
  // Note: bonus picks (champion / golden boot / golden glove) are individual prizes
  // and are not auto-scored. Check them manually at the end of the tournament.
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { applyEspnScores, forwardStatus, canon, normName };

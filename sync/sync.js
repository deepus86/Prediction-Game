// ============================================================
//  WORLD CUP 2026 — FIXTURE & RESULT SYNC
//  Pulls fixtures + final scores from football-data.org,
//  writes them to Supabase, then runs scoring.
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

const sb = (path, opts = {}) =>
  fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
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

async function main() {
  // 1. Fetch all World Cup matches.
  const res = await fetch('https://api.football-data.org/v4/competitions/WC/matches', {
    headers: { 'X-Auth-Token': FD_TOKEN },
  });
  if (!res.ok) {
    console.error('football-data.org error', res.status, await res.text());
    process.exit(1);
  }
  const { matches } = await res.json();
  console.log(`Fetched ${matches.length} matches.`);

  // 2. Shape rows for our table.
  const rows = matches.map((m) => {
    const ft = m.score?.fullTime || {};
    const finished = m.status === 'FINISHED';
    return {
      id: m.id,
      stage: m.stage,
      group_name: m.group || null,
      home_team: m.homeTeam?.name || 'TBD',
      away_team: m.awayTeam?.name || 'TBD',
      kickoff_at: m.utcDate,
      status: mapStatus(m.status),
      home_score: finished ? ft.home ?? null : null,
      away_score: finished ? ft.away ?? null : null,
      winner: finished ? mapWinner(m.score?.winner) : null,
      is_knockout: m.stage !== 'GROUP_STAGE',
    };
  });

  // 3. Upsert fixtures + results.
  const up = await sb('matches?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!up.ok) { console.error('Upsert failed', up.status, await up.text()); process.exit(1); }
  console.log('Fixtures/results upserted.');

  // 4. Record tournament start (earliest kickoff) so bonus prize picks lock correctly.
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

  // 5. Run match scoring.
  const sc = await sb('rpc/run_scoring', { method: 'POST', body: '{}' });
  if (!sc.ok) { console.error('Scoring failed', sc.status, await sc.text()); process.exit(1); }
  console.log('Scoring complete. Done.');
  // Note: bonus picks (champion / golden boot / golden glove) are individual prizes
  // and are not auto-scored. Check them manually at the end of the tournament.
}

main().catch((e) => { console.error(e); process.exit(1); });

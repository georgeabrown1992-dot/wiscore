#!/usr/bin/env node
/**
 * Pulls live data from the official Fantasy Premier League API,
 * writes public/fpl-data.json, and rewrites the embedded
 * <script id="wi-data-fpl"> block inside index.html so the app
 * works standalone (file:// or hosted) without a fetch() at runtime.
 *
 * Usage: node scripts/fetch-fpl.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FPL_URL = 'https://fantasy.premierleague.com/api/bootstrap-static/';

async function main() {
  const res = await fetch(FPL_URL, { headers: { 'User-Agent': 'wiscore-app/1.0' } });
  if (!res.ok) throw new Error(`FPL API request failed: ${res.status} ${res.statusText}`);
  const data = await res.json();

  const teams = (data.teams || []).map(t => ({
    id: t.id, code: t.code, name: t.name, short_name: t.short_name,
  }));

  const players = (data.elements || []).map(p => ({
    id: p.id,
    web_name: p.web_name,
    first_name: p.first_name,
    second_name: p.second_name,
    team: p.team,
    status: p.status, // a, d, i, s, u, n
    chance_of_playing_this_round: p.chance_of_playing_this_round,
    news: p.news || '',
  }));

  const currentEvent = (data.events || []).find(e => e.is_current)?.id ?? null;
  const nextEvent = (data.events || []).find(e => e.is_next)?.id ?? null;

  const out = {
    fetched_at: new Date().toISOString(),
    current_event: currentEvent,
    next_event: nextEvent,
    _synthetic: false,
    teams,
    players,
  };

  const publicDir = path.join(ROOT, 'public');
  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(path.join(publicDir, 'fpl-data.json'), JSON.stringify(out));
  console.log(`Wrote public/fpl-data.json — ${players.length} players, ${teams.length} teams.`);

  // Squad-diff: flag transfers in/out so squads.json (tiers) doesn't go stale silently.
  const squadsPath = path.join(publicDir, 'squads.json');
  if (fs.existsSync(squadsPath)) {
    const squads = JSON.parse(fs.readFileSync(squadsPath, 'utf8'));
    const norm = s => (s || '').toLowerCase().replace(/[^a-z]/g, '');
    const alerts = { generated: out.fetched_at, clubs: {} };
    squads.clubs.forEach(club => {
      const team = teams.find(t => t.name === club.name || t.short_name === club.short);
      if (!team) { alerts.clubs[club.name] = { missing: [], added: [], note: 'No matching FPL team — check name/short.' }; return; }
      const teamPlayers = players.filter(p => p.team === team.id);
      const missing = (club.players || []).filter(p => !teamPlayers.some(fp => norm(fp.web_name).includes(norm(p.name)) || norm(fp.second_name).includes(norm(p.name))));
      const added = teamPlayers.filter(fp => !(club.players || []).some(p => norm(fp.web_name).includes(norm(p.name)) || norm(fp.second_name).includes(norm(p.name))));
      if (missing.length || added.length) {
        alerts.clubs[club.name] = {
          missing: missing.map(p => p.name),
          added: added.map(fp => ({ name: fp.web_name, status: fp.status })),
        };
      }
    });
    fs.writeFileSync(path.join(publicDir, 'squad-alerts.json'), JSON.stringify(alerts));
    const flagged = Object.keys(alerts.clubs).length;
    console.log(`Wrote public/squad-alerts.json — ${flagged} club(s) with squad changes to review.`);
  }

  // Rewrite the embedded block in index.html so the app works from file:// too.
  const indexPath = path.join(ROOT, 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');
  const re = /(<script id="wi-data-fpl" type="application\/json">)([\s\S]*?)(<\/script>)/;
  if (re.test(html)) {
    html = html.replace(re, (_m, open, _old, close) => `${open}${JSON.stringify(out)}${close}`);
    fs.writeFileSync(indexPath, html);
    console.log('Rewrote embedded wi-data-fpl block in index.html.');
  } else {
    console.warn('Could not find wi-data-fpl block in index.html — skipped rewrite.');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

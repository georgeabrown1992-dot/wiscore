#!/usr/bin/env node
/**
 * Nightly data job for WIscore.
 *
 *  1. Pulls live data from the official Fantasy Premier League API and writes
 *     public/fpl-data.json.
 *  2. Auto-reconciles public/squads.json against the live FPL squads:
 *     players whose FPL club changed are MOVED, players who have left the
 *     league (status 'u' / "has joined ..." news) are REMOVED. Every change is
 *     written to public/transfers.json.
 *  3. Appends VERIFIED gameweek history only: one entry per finished gameweek,
 *     recording each club's WIscore and real league position at that point.
 *     Nothing is ever back-filled or synthesised.
 *  4. Refreshes the embedded JSON blocks in index.html so the app also works
 *     from file://.
 *
 * Usage: node scripts/fetch-fpl.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const FPL_URL = 'https://fantasy.premierleague.com/api/bootstrap-static/';

const strip = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const DEPARTED_NEWS = /(has joined|joined on loan|on loan (at|to)|left the club|transferred|signed for)/i;
const isDeparted = p => !!p && (p.status === 'u' || DEPARTED_NEWS.test(p.news || ''));
const isOut = p => {
  if (!p || isDeparted(p)) return false;
  if (p.status === 'i' || p.status === 's') return true;
  return p.status === 'd' && (p.chance_this === null || p.chance_this <= 50);
};

const readJson = f => { try { return JSON.parse(fs.readFileSync(path.join(PUB, f), 'utf8')); } catch { return null; } };
const writeJson = (f, o) => fs.writeFileSync(path.join(PUB, f), JSON.stringify(o));

/* Match one squad name against a pool of FPL players. */
function matchPlayer(name, pool) {
  const pn = strip(name);
  let hits = pool.filter(fp => strip(fp.web_name) === pn || strip(fp.second_name) === pn);
  if (!hits.length) hits = pool.filter(fp => strip(fp.second_name).endsWith(pn) || strip(fp.web_name).includes(pn));
  return hits.length === 1 ? hits[0] : null; // ambiguous -> no match, flagged for review
}

function clubWIscore(club, players, teams, tierWeights) {
  const team = teams.find(t => t.name === club.name || t.short_name === club.short);
  const pool = team ? players.filter(p => p.team === team.id) : [];
  const list = (club.players && club.players.length) ? club.players
    : [{ name: club.best, tier: 'best' }].concat(
        (club.first || []).map(n => ({ name: n, tier: 'first' })),
        (club.sub || []).map(n => ({ name: n, tier: 'sub' })),
        (club.youth || []).map(n => ({ name: n, tier: 'youth' })));
  let total = 0;
  list.forEach(p => {
    const fp = matchPlayer(p.name, pool);
    if (isOut(fp)) total += (typeof p.score === 'number') ? p.score : tierWeights[p.tier];
  });
  return Math.round(total * 100) / 100;
}

/* ---- squads.json <-> live FPL reconciliation ------------------------------ */
function reconcileSquads(squads, players, teams) {
  const log = { generated: new Date().toISOString(), moves: [], out: [], review: [] };
  const clubOf = new Map(); // fpl team id -> squad club
  squads.clubs.forEach(c => {
    const t = teams.find(t => t.name === c.name || t.short_name === c.short);
    if (t) clubOf.set(t.id, c); else log.review.push({ club: c.name, reason: 'No matching FPL team - check name/short.' });
  });

  const ensurePlayers = c => { if (!Array.isArray(c.players) || !c.players.length) {
    c.players = [{ name: c.best, tier: 'best' }].concat(
      (c.first || []).map(n => ({ name: n, tier: 'first' })),
      (c.sub || []).map(n => ({ name: n, tier: 'sub' })),
      (c.youth || []).map(n => ({ name: n, tier: 'youth' })));
  } };
  squads.clubs.forEach(ensurePlayers);

  squads.clubs.forEach(club => {
    const team = teams.find(t => t.name === club.name || t.short_name === club.short);
    const pool = team ? players.filter(p => p.team === team.id) : [];
    club.players.slice().forEach(p => {
      const inClub = matchPlayer(p.name, pool);
      if (inClub && !isDeparted(inClub)) return; // still here, all good

      const fp = inClub || matchPlayer(p.name, players);
      if (!fp) { log.review.push({ club: club.name, player: p.name, reason: 'Not found in FPL data - check spelling or confirm departure.' }); return; }

      if (isDeparted(fp)) {
        club.players = club.players.filter(x => x !== p);
        log.out.push({ player: p.name, club: club.name, reason: (fp.news || 'Listed unavailable by FPL').trim() });
        return;
      }
      const dest = clubOf.get(fp.team);
      if (dest && dest !== club) {
        club.players = club.players.filter(x => x !== p);
        const tier = p.tier === 'best' ? 'first' : p.tier; // one 'best' per club only
        dest.players.push({ ...p, tier });
        log.moves.push({ player: p.name, from: club.name, to: dest.name, tier });
      }
    });
  });

  // Re-derive the tier arrays (and promote a new 'best' where one departed).
  squads.clubs.forEach(c => {
    if (!c.players.some(p => p.tier === 'best')) {
      const next = c.players.filter(p => p.tier === 'first').sort((a, b) => (b.score || 0) - (a.score || 0))[0];
      if (next) { next.tier = 'best'; log.review.push({ club: c.name, player: next.name, reason: 'Promoted to Best after departure - confirm.' }); }
    }
    const byTier = t => c.players.filter(p => p.tier === t).sort((a, b) => (b.score || 0) - (a.score || 0)).map(p => p.name);
    c.best = (c.players.find(p => p.tier === 'best') || {}).name || c.best;
    c.first = byTier('first'); c.sub = byTier('sub'); c.youth = byTier('youth');
  });

  squads.generated = log.generated;
  return log;
}

/* ---- verified gameweek history ------------------------------------------- */
function appendVerifiedHistory(hist, squads, data, players, teams) {
  const finished = (data.events || []).filter(e => e.finished).map(e => e.id).sort((a, b) => a - b);
  const latest = finished[finished.length - 1];
  if (!latest) return { hist, added: null };

  const h = hist && Array.isArray(hist.gameweeks) ? hist : { season: '26/27', verified: true, gameweeks: [], clubs: {} };
  if (h.gameweeks.includes(latest)) return { hist: h, added: null };

  h.gameweeks.push(latest);
  h.gameweeks.sort((a, b) => a - b);
  const idx = h.gameweeks.indexOf(latest);
  squads.clubs.forEach(club => {
    const t = teams.find(t => t.name === club.name || t.short_name === club.short);
    const rec = h.clubs[club.name] || (h.clubs[club.name] = { wiscore: [], league_position: [] });
    rec.wiscore.splice(idx, 0, clubWIscore(club, players, teams, squads.tierWeights));
    rec.league_position.splice(idx, 0, t && t.position ? t.position : null);
  });
  h.verified_through = latest;
  h.updated = new Date().toISOString();
  return { hist: h, added: latest };
}

async function main() {
  const res = await fetch(FPL_URL, { headers: { 'User-Agent': 'wiscore-app/1.0' } });
  if (!res.ok) throw new Error(`FPL API request failed: ${res.status} ${res.statusText}`);
  const data = await res.json();

  const teams = (data.teams || []).map(t => ({
    id: t.id, code: t.code, name: t.name, short_name: t.short_name,
    position: t.position ?? null, played: t.played ?? null, points: t.points ?? null,
  }));
  const players = (data.elements || []).map(p => ({
    id: p.id, web_name: p.web_name, first_name: p.first_name, second_name: p.second_name,
    team: p.team, status: p.status, chance_this: p.chance_of_playing_this_round,
    chance_next: p.chance_of_playing_next_round, news: p.news || '',
  }));

  const events = data.events || [];
  const finishedGws = events.filter(e => e.finished).map(e => e.id);
  const out = {
    fetched_at: new Date().toISOString(),
    current_event: events.find(e => e.is_current)?.id ?? null,
    next_event: events.find(e => e.is_next)?.id ?? null,
    finished_gameweeks: finishedGws,
    verified_through: finishedGws.length ? Math.max(...finishedGws) : 0,
    _synthetic: false,
    teams, players,
  };

  fs.mkdirSync(PUB, { recursive: true });
  writeJson('fpl-data.json', out);
  console.log(`fpl-data.json - ${players.length} players, GW${out.current_event ?? '-'} current, verified through GW${out.verified_through}.`);

  const squads = readJson('squads.json');
  let hist = readJson('gameweek-history.json');
  if (squads) {
    const log = reconcileSquads(squads, players, teams);
    writeJson('squads.json', squads);
    writeJson('transfers.json', log);
    console.log(`transfers.json - ${log.moves.length} moved, ${log.out.length} removed, ${log.review.length} to review.`);

    const r = appendVerifiedHistory(hist, squads, data, players, teams);
    hist = r.hist;
    writeJson('gameweek-history.json', hist);
    console.log(r.added ? `gameweek-history.json - recorded GW${r.added}.` : 'gameweek-history.json - no new finished gameweek.');
  }

  // Refresh the embedded blocks so the app works from file:// too.
  const indexPath = path.join(ROOT, 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');
  const embed = (id, obj) => {
    const re = new RegExp(`(<script id="${id}" type="application/json">)([\\s\\S]*?)(</script>)`);
    if (obj && re.test(html)) { html = html.replace(re, (_m, o, _x, c) => `${o}${JSON.stringify(obj)}${c}`); return true; }
    return false;
  };
  const done = [embed('wi-data-fpl', out), embed('wi-data-squads', squads), embed('wi-data-history', hist)];
  fs.writeFileSync(indexPath, html);
  console.log(`index.html - embedded blocks refreshed (${done.filter(Boolean).length}).`);
}

main().catch(err => { console.error(err); process.exit(1); });

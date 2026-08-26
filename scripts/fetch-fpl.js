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
const { loadTransferFeed, FEED_URL } = require('./fetch-transfers');

const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const FPL_URL = 'https://fantasy.premierleague.com/api/bootstrap-static/';
const FIXTURES_URL = 'https://fantasy.premierleague.com/api/fixtures/';

const strip = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
const DEPARTED_NEWS = /(has joined|joined on loan|on loan (at|to)|left the club|transferred|signed for)/i;
const isDeparted = p => !!p && (p.status === 'u' || DEPARTED_NEWS.test(p.news || ''));
const isOut = p => {
  if (!p || isDeparted(p)) return false;
  if (p.status === 'i' || p.status === 's') return true;
  return p.status === 'd' && (p.chance_this === null || p.chance_this <= 50);
};

const readJson = f => { try { return JSON.parse(fs.readFileSync(path.join(PUB, f), 'utf8')); } catch { return null; } };
const writeJson = (f, o) => fs.writeFileSync(path.join(PUB, f), JSON.stringify(o));

/* Exact-only name matching. Substring matching used to create phantom players
 * (squad entry "Leon" matching FPL "Leoni"), so every candidate key must match
 * the squad name in full. */
function nameKeys(fp) {
  return [fp.web_name, fp.second_name, `${fp.first_name} ${fp.second_name}`,
    `${fp.first_name} ${fp.web_name}`, `${fp.web_name} ${fp.second_name}`].map(strip);
}
function findPlayers(name, pool) {
  const pn = strip(name);
  if (!pn) return [];
  let hits = pool.filter(fp => nameKeys(fp).includes(pn));
  if (!hits.length) {
    const last = w => strip(w.second_name).split(' ').slice(-1)[0];
    hits = pool.filter(fp => last(fp) === pn); // surname-only squad entry
  }
  return hits;
}
function matchPlayer(name, pool) {
  const hits = findPlayers(name, pool);
  return hits.length === 1 ? hits[0] : null; // ambiguous -> no match, flagged for review
}

/* ---- league table computed from finished fixtures -------------------------
 * FPL's bootstrap teams[] carries position: 0 all season, so standings have to
 * be derived from results or league position never populates. */
function computeStandings(fixtures, teams) {
  const rows = new Map(teams.map(t => [t.id, { id: t.id, name: t.name, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, points: 0 }]));
  (fixtures || []).filter(f => f.finished && f.team_h_score !== null).forEach(f => {
    const h = rows.get(f.team_h), a = rows.get(f.team_a);
    if (!h || !a) return;
    const hs = f.team_h_score, as = f.team_a_score;
    h.played++; a.played++; h.gf += hs; h.ga += as; a.gf += as; a.ga += hs;
    if (hs > as) { h.won++; a.lost++; h.points += 3; }
    else if (hs < as) { a.won++; h.lost++; a.points += 3; }
    else { h.drawn++; a.drawn++; h.points++; a.points++; }
  });
  const list = [...rows.values()].map(r => ({ ...r, gd: r.gf - r.ga }));
  list.sort((a, b) => b.points - a.points || b.gd - a.gd || b.gf - a.gf || a.name.localeCompare(b.name));
  list.forEach((r, i) => { r.position = list.some(x => x.played > 0) ? i + 1 : null; });
  return list;
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

/* Re-derive the tier arrays (and promote a new 'best' where one departed). */
function rebuildTiers(squads, log) {
  squads.clubs.forEach(c => {
    if (!c.players.some(p => p.tier === 'best')) {
      const next = c.players.filter(p => p.tier === 'first').sort((a, b) => (b.score || 0) - (a.score || 0))[0];
      if (next) { next.tier = 'best'; log.review.push({ club: c.name, player: next.name, reason: 'Promoted to Best after departure - confirm.' }); }
    }
    const byTier = t => c.players.filter(p => p.tier === t).sort((a, b) => (b.score || 0) - (a.score || 0)).map(p => p.name);
    c.best = (c.players.find(p => p.tier === 'best') || {}).name || c.best;
    c.first = byTier('first'); c.sub = byTier('sub'); c.youth = byTier('youth');
  });
}

/* ---- confirmed-transfer feed --------------------------------------------- */
/* Tracker club names are short forms; map them onto squads.json club names. */
const CLUB_ALIASES = {
  'man utd': 'Manchester United', 'man united': 'Manchester United', 'manchester utd': 'Manchester United',
  'man city': 'Manchester City', 'spurs': 'Tottenham Hotspur', 'tottenham': 'Tottenham Hotspur',
  'nottm forest': 'Nottingham Forest', "nott'm forest": 'Nottingham Forest', 'notts forest': 'Nottingham Forest',
  'wolves': 'Wolverhampton Wanderers', 'brighton hove albion': 'Brighton', 'brighton and hove albion': 'Brighton',
  'newcastle': 'Newcastle United', 'leeds': 'Leeds United', 'west ham': 'West Ham United',
  'afc bournemouth': 'Bournemouth', 'hull': 'Hull City', 'ipswich': 'Ipswich Town',
  'coventry': 'Coventry City', 'palace': 'Crystal Palace', 'sheff utd': 'Sheffield United',
};
function clubResolver(squads) {
  const byKey = new Map();
  squads.clubs.forEach(c => {
    [c.name, c.short, strip(c.name).replace(/ (united|city|hotspur|wanderers|albion)$/, '')].forEach(k => {
      if (k) byKey.set(strip(k), c);
    });
  });
  return raw => {
    const k = strip(raw);
    if (!k) return null;
    const alias = CLUB_ALIASES[k];
    return byKey.get(strip(alias || k)) || byKey.get(k) || null;
  };
}

/* Apply the tracker's confirmed deals to squads.json.
 * In-league moves and exits are applied; incoming signings are queued for a
 * human to weight (a new player needs a tier/score before he can score). */
function applyFeed(squads, feed, log) {
  const resolve = clubResolver(squads);
  log.feed = { source: feed.source, fetched_at: feed.fetched_at, rows: feed.rows.length, error: feed.error };
  log.arrivals = log.arrivals || [];
  if (!feed.rows.length) return;

  feed.rows.forEach(row => {
    const from = resolve(row.from), to = resolve(row.to);
    if (!from && !to) return; // deal between two clubs outside our league
    const detail = [row.fee, row.date].filter(Boolean).join(' | ');

    if (from) {
      const pn = strip(row.player);
      let hits = from.players.filter(p => strip(p.name) === pn);
      if (!hits.length) hits = from.players.filter(p => strip(p.name).endsWith(pn) || pn.endsWith(strip(p.name)));
      const entry = hits.length === 1 ? hits[0] : null;
      if (hits.length > 1) log.review.push({ club: from.name, player: row.player, reason: 'Transfer feed name matches more than one squad player.' });
      if (entry) {
        from.players = from.players.filter(x => x !== entry);
        if (to && to !== from) {
          const tier = entry.tier === 'best' ? 'first' : entry.tier;
          to.players.push({ ...entry, tier });
          log.moves.push({ player: entry.name, from: from.name, to: to.name, tier, source: 'transfer feed', detail });
        } else {
          log.out.push({ player: entry.name, club: from.name, reason: `Left for ${row.to || 'another club'} - confirmed by transfer feed`, detail });
        }
        return;
      }
    }
    if (to && !from) {
      log.arrivals.push({ player: row.player, club: to.name, from: row.from || 'unknown', detail,
        note: 'New signing - add in the Transfer desk with a tier so he can score.' });
    }
  });
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
      if (!fp) {
        // Ambiguous name -> leave alone and ask a human. Genuinely absent from the
        // league's player list -> the player has left; drop them from the squad.
        if (findPlayers(p.name, players).length > 1) {
          log.review.push({ club: club.name, player: p.name, reason: 'Ambiguous name - several FPL players match. Fix in Transfer desk.' });
          return;
        }
        club.players = club.players.filter(x => x !== p);
        log.out.push({ player: p.name, club: club.name, reason: 'No longer listed in the FPL player data - left the club or the league.' });
        return;
      }

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

  // Re-derive the tier arrays.
  rebuildTiers(squads, log);

  squads.generated = log.generated;
  return log;
}

/* ---- verified gameweek history ------------------------------------------- */
function appendVerifiedHistory(hist, squads, data, players, teams, standings) {
  // Require BOTH flags: 'finished' alone can be set before FPL has finalised bonus/standings.
  const finished = (data.events || []).filter(e => e.finished && e.data_checked).map(e => e.id).sort((a, b) => a - b);
  const latest = finished[finished.length - 1];
  if (!latest) return { hist, added: null };
  // And wait until results exist, or positions would record as null.
  if (!standings.some(s => s.played > 0)) return { hist, added: null };
  const posOf = new Map(standings.map(s => [s.id, s.position]));

  const h = hist && Array.isArray(hist.gameweeks) ? hist : { season: '26/27', verified: true, gameweeks: [], clubs: {} };
  if (h.gameweeks.includes(latest)) return { hist: h, added: null };

  h.gameweeks.push(latest);
  h.gameweeks.sort((a, b) => a - b);
  const idx = h.gameweeks.indexOf(latest);
  squads.clubs.forEach(club => {
    const t = teams.find(t => t.name === club.name || t.short_name === club.short);
    const rec = h.clubs[club.name] || (h.clubs[club.name] = { wiscore: [], league_position: [] });
    rec.wiscore.splice(idx, 0, clubWIscore(club, players, teams, squads.tierWeights));
    rec.league_position.splice(idx, 0, (t && posOf.get(t.id)) || null);
  });
  h.verified_through = latest;
  h.updated = new Date().toISOString();
  return { hist: h, added: latest };
}

async function main() {
  const res = await fetch(FPL_URL, { headers: { 'User-Agent': 'wiscore-app/1.0' } });
  if (!res.ok) throw new Error(`FPL API request failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const fxRes = await fetch(FIXTURES_URL, { headers: { 'User-Agent': 'wiscore-app/1.0' } });
  const fixtures = fxRes.ok ? await fxRes.json() : [];

  const rawTeams = (data.teams || []).map(t => ({ id: t.id, code: t.code, name: t.name, short_name: t.short_name }));
  const standings = computeStandings(fixtures, rawTeams);
  const stand = new Map(standings.map(s => [s.id, s]));
  const teams = rawTeams.map(t => {
    const s = stand.get(t.id) || {};
    return { ...t, position: s.position ?? null, played: s.played ?? 0, points: s.points ?? 0, gd: s.gd ?? 0 };
  });
  const players = (data.elements || []).map(p => ({
    id: p.id, web_name: p.web_name, first_name: p.first_name, second_name: p.second_name,
    team: p.team, status: p.status, chance_this: p.chance_of_playing_this_round,
    chance_next: p.chance_of_playing_next_round, news: p.news || '',
  }));

  const events = data.events || [];
  const finishedGws = events.filter(e => e.finished && e.data_checked).map(e => e.id);
  const out = {
    fetched_at: new Date().toISOString(),
    current_event: events.find(e => e.is_current)?.id ?? null,
    next_event: events.find(e => e.is_next)?.id ?? null,
    finished_gameweeks: finishedGws,
    verified_through: finishedGws.length ? Math.max(...finishedGws) : 0,
    _synthetic: false,
    teams, players, standings,
  };

  fs.mkdirSync(PUB, { recursive: true });
  writeJson('fpl-data.json', out);
  console.log(`fpl-data.json - ${players.length} players, GW${out.current_event ?? '-'} current, verified through GW${out.verified_through}.`);

  const squads = readJson('squads.json');
  let hist = readJson('gameweek-history.json');
  if (squads) {
    const log = reconcileSquads(squads, players, teams);

    // Confirmed deals from the published tracker, applied on top of the FPL view.
    let feed = { source: FEED_URL, fetched_at: new Date().toISOString(), rows: [], error: null };
    try { feed = await loadTransferFeed(); } catch (e) { feed.error = String(e.message || e); }
    writeJson('transfer-feed.json', feed);
    applyFeed(squads, feed, log);
    rebuildTiers(squads, log);
    squads.generated = new Date().toISOString();
    console.log(feed.error ? `transfer feed - ${feed.error}` : `transfer feed - ${feed.rows.length} deals read.`);

    writeJson('squads.json', squads);
    writeJson('transfers.json', log);
    console.log(`transfers.json - ${log.moves.length} moved, ${log.out.length} removed, ${log.arrivals.length} arrivals to weight, ${log.review.length} to review.`);

    const r = appendVerifiedHistory(hist, squads, data, players, teams, standings);
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

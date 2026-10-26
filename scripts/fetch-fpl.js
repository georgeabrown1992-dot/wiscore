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
 *  3. Rebuilds gameweek history: league position after EVERY finished
 *     gameweek is recomputed nightly from actual results and checked against
 *     the live table. WIscore is recorded once per gameweek and never invented.
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

const strip = s => (s || '').replace(/[øØ]/g, 'o').replace(/ß/g, 'ss').replace(/[æÆ]/g, 'ae').replace(/[đĐ]/g, 'd').replace(/[łŁ]/g, 'l')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
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
  if (!hits.length && pn.includes(' ')) {
    // Full name from the editorial list: first name + any surname word must match.
    const w = pn.split(' '), first = w[0], lastW = w[w.length - 1];
    hits = pool.filter(fp => strip(fp.first_name).split(' ')[0] === first && strip(fp.second_name).split(' ').includes(lastW));
  }
  return hits;
}
function matchPlayer(name, pool) {
  const hits = findPlayers(name, pool);
  return hits.length === 1 ? hits[0] : null; // ambiguous -> no match, flagged for review
}
/* Squad entry -> FPL player: the stored FPL id wins, then the exact name rules. */
function matchEntry(p, pool) {
  if (p && p.fpl_id != null) { const f = pool.find(x => x.id === p.fpl_id); if (f) return f; }
  return matchPlayer(p && p.name, pool);
}

/* ---- spelling reconciliation -----------------------------------------------
 * Names typed from a squad list often differ from FPL's (accents, full vs short
 * names, mononyms, a typo). Within the player's OWN club only, every word of the
 * listed name must appear in FPL's first / second / display name (one letter of
 * slack on words of 5+ letters). A unique hit is linked by FPL id and the entry
 * is renamed to FPL's display name so the site matches it too. Every rename is
 * logged; anything still unmatched or ambiguous is flagged, never guessed. */
function near(a, b) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
function fuzzyFind(name, pool) {
  const words = strip(name).split(' ').filter(w => w.length > 1);
  if (!words.length) return [];
  const toks = fp => strip(`${fp.first_name} ${fp.second_name} ${fp.web_name}`).split(' ');
  let hits = pool.filter(fp => { const t = toks(fp); return words.every(w => t.some(x => near(w, x))); });
  if (!hits.length) hits = pool.filter(fp => { const wn = strip(fp.web_name); return wn.length > 3 && words.includes(wn); });
  if (!hits.length && words.length > 1) {
    const last = words[words.length - 1];
    hits = pool.filter(fp => strip(fp.second_name).split(' ').some(x => near(last, x)) && strip(fp.first_name)[0] === words[0][0]);
  }
  return hits;
}
function reconcileNames(squads, players, clubOf, log) {
  log.renamed = [];
  clubOf.forEach((club, teamId) => {
    const pool = players.filter(fp => fp.team === teamId);
    const claimed = new Set();
    const pending = [];
    club.players.forEach(p => {
      const idHit = p.fpl_id != null && pool.find(x => x.id === p.fpl_id);
      const hits = idHit ? [idHit] : findPlayers(p.name, pool);
      if (hits.length === 1 && !claimed.has(hits[0].id)) { p.fpl_id = hits[0].id; claimed.add(hits[0].id); }
      else pending.push(p);
    });
    pending.forEach(p => {
      const hits = fuzzyFind(p.full_name || p.name, pool).filter(fp => !claimed.has(fp.id));
      if (hits.length !== 1) {
        if (hits.length > 1) log.review.push({ club: club.name, player: p.name, reason: `Spelling check - could be ${hits.map(h => h.web_name).join(' or ')}. Pick the right one in admin.` });
        return;
      }
      const fp = hits[0];
      claimed.add(fp.id);
      p.fpl_id = fp.id;
      if (!p.full_name) p.full_name = p.name;
      if (p.name !== fp.web_name) { log.renamed.push({ club: club.name, from: p.name, to: fp.web_name }); p.name = fp.web_name; }
    });
  });
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

/* ---- live league table from an external source --------------------------
 * The FPL fixtures feed can lag or disagree with the official table, so the
 * real standings are pulled from a live source first:
 *   1. football-data.org (if a FOOTBALL_DATA_KEY secret is set)
 *   2. ESPN's public standings feed (no key needed)
 *   3. falls back to the table computed from FPL fixtures above.
 * Every source is mapped onto FPL team ids by a canonical club key. */
function clubKey(name) {
  const n = strip(name).toLowerCase().replace(/[^a-z' ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/tottenham|^spurs/.test(n)) return 'TOT';
  if (/man(chester)? city/.test(n)) return 'MCI';
  if (/man(chester)? (utd|united)/.test(n)) return 'MUN';
  if (/forest|nott/.test(n)) return 'NFO';
  if (/villa/.test(n)) return 'AVL';
  if (/palace/.test(n)) return 'CRY';
  if (/west ham/.test(n)) return 'WHU';
  if (/wolves|wolverhampton/.test(n)) return 'WOL';
  const w = n.replace(/^afc /, '').split(' ')[0];
  return w.toUpperCase();
}

async function fetchJson(url, headers) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'wiscore-app/1.0', ...(headers || {}) } });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}

async function fetchLiveTable() {
  const key = process.env.FOOTBALL_DATA_KEY;
  if (key) {
    const j = await fetchJson('https://api.football-data.org/v4/competitions/PL/standings', { 'X-Auth-Token': key });
    const table = j && (j.standings || []).find(s => s.type === 'TOTAL');
    if (table && table.table && table.table.length >= 20) return {
      source: 'football-data.org',
      rows: table.table.map(r => ({ name: r.team.shortName || r.team.name, alt: [r.team.name, r.team.tla], position: r.position,
        played: r.playedGames, won: r.won, drawn: r.draw, lost: r.lost, gf: r.goalsFor, ga: r.goalsAgainst, gd: r.goalDifference, points: r.points })),
    };
  }
  const e = await fetchJson('https://site.api.espn.com/apis/v2/sports/soccer/eng.1/standings');
  const entries = e && ((e.children && e.children[0] && e.children[0].standings && e.children[0].standings.entries) || (e.standings && e.standings.entries));
  if (entries && entries.length >= 20) {
    const stat = (en, ...names) => { for (const n of names) { const s = (en.stats || []).find(x => x.name === n || x.type === n); if (s && s.value != null) return +s.value; } return null; };
    const rows = entries.map(en => ({
      name: en.team.displayName, alt: [en.team.shortDisplayName, en.team.name, en.team.abbreviation],
      position: stat(en, 'rank'), played: stat(en, 'gamesPlayed'), won: stat(en, 'wins'), drawn: stat(en, 'ties'), lost: stat(en, 'losses'),
      gf: stat(en, 'pointsFor'), ga: stat(en, 'pointsAgainst'), gd: stat(en, 'pointDifferential'), points: stat(en, 'points'),
    }));
    if (rows.some(r => r.position == null)) {
      rows.sort((a, b) => b.points - a.points || b.gd - a.gd || b.gf - a.gf);
      rows.forEach((r, i) => { r.position = i + 1; });
    }
    return { source: 'espn', rows };
  }
  return null;
}

/* Map a live table onto FPL team ids. Returns null unless every club matches. */
function mapLiveTable(live, teams) {
  if (!live) return null;
  const byKey = new Map(teams.map(t => [clubKey(t.name), t]));
  const out = [];
  for (const r of live.rows) {
    const t = [r.name, ...(r.alt || [])].filter(Boolean).map(clubKey).map(k => byKey.get(k)).find(Boolean);
    if (!t) { console.warn(`live table (${live.source}) - no FPL match for "${r.name}"`); return null; }
    out.push({ id: t.id, name: t.name, played: r.played, won: r.won, drawn: r.drawn, lost: r.lost, gf: r.gf, ga: r.ga, gd: r.gd, points: r.points, position: r.position });
  }
  return out.length === teams.length ? out.sort((a, b) => a.position - b.position) : null;
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
    const fp = matchEntry(p, pool);
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

/* ---- squad rules: every club re-tiered nightly from live FPL data ----------
 * Pool = every player FPL lists at the club (missing ones are added).
 * Value = FPL price as a percentile among every player at his position in
 * the league (so a £5.3m midfielder and a £4.9m defender are compared fairly).
 * FPL sets prices on a player's standing, not his current form or fitness, so
 * an injured first-teamer keeps his tier. Total points only break ties.
 *   First choice (incl. Best): squadRules.firstChoice - a valid XI core: 1 GK,
 *     4+ DEF, 3+ MID, 1+ FWD, max 1 GK.
 *   First sub: squadRules.firstSub - always includes the back-up keeper.
 *   Youth / rotation: the rest, up to squadRules.maxSquad. Injured players
 *     take these places ahead of fit fringe players.
 * 'Best' is editorial and is never changed here unless he has left. */
const POS = { 1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD' };
const ANCHOR = { best: 5, first: 3, sub: 2, youth: 1 };
const TIER_LABEL = { best: 'Best', first: 'First choice', sub: 'First sub', youth: 'Youth / rotation' };
function applySquadRules(squads, players, clubOf, log) {
  const R = squads.squadRules || (squads.squadRules = {});
  if (squads.tiersLocked) {
    // Tiers come from the editorial squad list: only refresh price / points.
    log.added = []; log.trimmed = []; log.retiered = [];
    clubOf.forEach((club, teamId) => {
      const pool = players.filter(fp => fp.team === teamId);
      club.players.forEach(p => {
        const fp = matchEntry(p, pool);
        if (fp) Object.assign(p, { fpl_id: fp.id, price: fp.price, tp: fp.tp, pos: POS[fp.element_type] || p.pos });
      });
    });
    log.squadRules = { maxSquad: R.maxSquad || 30, firstChoice: R.firstChoice || 15, firstSub: R.firstSub || 9, locked: true };
    return;
  }
  const MAX = R.maxSquad || 30, FIRST = R.firstChoice || 13, SUB = R.firstSub || 9;
  log.added = []; log.trimmed = []; log.retiered = [];
  const pricesAt = {};
  players.forEach(p => { if (p.price != null && !isDeparted(p)) (pricesAt[p.element_type] = pricesAt[p.element_type] || []).push(p.price); });
  const pct = (t, price) => { const xs = pricesAt[t] || []; if (!xs.length || price == null) return 0; return xs.filter(x => x < price).length / xs.length + 0.5 * xs.filter(x => x === price).length / xs.length; };
  const flagged = fp => !!fp && (['d', 'i', 's', 'n'].includes(fp.status) || (fp.chance_next != null && fp.chance_next < 75));
  const r2 = x => Math.round(x * 100) / 100;

  clubOf.forEach((club, teamId) => {
    const pool = players.filter(fp => fp.team === teamId && !isDeparted(fp));
    const rows = [], fixed = [];
    club.players.forEach(p => {
      const fp = matchEntry(p, pool);
      if (fp) rows.push({ p, fp, was: p.tier, isNew: false });
      else fixed.push(p); // ambiguous / unmatched: keep exactly as is
    });
    pool.forEach(fp => {
      if (rows.some(r => r.fp === fp)) return;
      rows.push({ p: { name: fp.web_name, tier: 'youth', score: null, auto_added: true }, fp, was: null, isNew: true });
    });
    const lead = Math.max(1, ...rows.map(r => r.fp.tp || 0));
    rows.forEach(r => {
      const priceS = pct(r.fp.element_type, r.fp.price);
      const ptsS = Math.max(0, r.fp.tp || 0) / lead;
      r.hurt = flagged(r.fp);
      r.v = priceS + 0.001 * ptsS;
      r.pos = POS[r.fp.element_type] || r.p.pos || null;
      Object.assign(r.p, { pos: r.pos, price: r.fp.price, tp: r.fp.tp });
    });
    rows.sort((a, b) => b.v - a.v);

    const fixedN = t => fixed.filter(p => p.tier === t).length;
    const take = new Set();
    const best = fixedN('best') ? null : (rows.find(r => r.p.tier === 'best') || rows[0]);
    if (best) { take.add(best); best.tier = 'best'; }
    const firstRows = best ? [best] : [];
    const FIRST_CAP = FIRST - fixedN('first') - fixedN('best'), SUB_CAP = SUB - fixedN('sub');
    const cnt = pos => firstRows.filter(r => r.pos === pos).length + fixed.filter(p => (p.tier === 'first' || p.tier === 'best') && p.pos === pos).length;
    const pick = (r, tier, into) => { take.add(r); r.tier = tier; if (into) into.push(r); };
    [['GK', 1], ['DEF', 4], ['MID', 3], ['FWD', 1]].forEach(([pos, min]) => {
      rows.filter(r => !take.has(r) && r.pos === pos).slice(0, Math.max(0, min - cnt(pos))).forEach(r => pick(r, 'first', firstRows));
    });
    rows.filter(r => !take.has(r) && !(r.pos === 'GK' && cnt('GK') >= 1)).forEach(r => { if (firstRows.length < FIRST_CAP) pick(r, 'first', firstRows); });
    const subs = [];
    const gk2 = rows.find(r => !take.has(r) && r.pos === 'GK');
    if (gk2 && SUB_CAP > 0) pick(gk2, 'sub', subs);
    rows.filter(r => !take.has(r)).forEach(r => { if (subs.length < SUB_CAP) pick(r, 'sub', subs); });
    const room = Math.max(0, MAX - take.size - fixed.length);
    rows.filter(r => !take.has(r)).sort((a, b) => (b.hurt - a.hurt) || (b.v - a.v)).slice(0, room).forEach(r => pick(r, 'youth'));

    const kept = rows.filter(r => take.has(r));
    kept.forEach(r => {
      const old = typeof r.p.score === 'number' && r.was ? r.p.score - ANCHOR[r.was] : null;
      const offset = old != null ? Math.max(-0.5, Math.min(0.5, old)) : (r.v - 0.5) * 0.5;
      if (r.isNew || r.was !== r.tier) r.p.score = r2(Math.max(0.1, ANCHOR[r.tier] + offset));
      if (r.isNew) log.added.push({ player: r.p.name, club: club.name, tier: r.tier, status: r.fp.status, news: r.fp.news || '' });
      else if (r.was !== r.tier) log.retiered.push({ player: r.p.name, club: club.name, from: r.was, to: r.tier });
      r.p.tier = r.tier;
    });
    rows.filter(r => !take.has(r) && !r.isNew).forEach(r => log.trimmed.push({ player: r.p.name, club: club.name, reason: `Outside the ${MAX}-man squad on FPL price + points` }));
    club.players = kept.map(r => r.p).concat(fixed);
  });
  log.squadRules = { maxSquad: MAX, firstChoice: FIRST, firstSub: SUB };
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
  reconcileNames(squads, players, clubOf, log);

  squads.clubs.forEach(club => {
    const team = teams.find(t => t.name === club.name || t.short_name === club.short);
    const pool = team ? players.filter(p => p.team === team.id) : [];
    club.players.slice().forEach(p => {
      const inClub = matchEntry(p, pool);
      if (inClub && !isDeparted(inClub)) return; // still here, all good

      const fp = inClub || matchEntry(p, players);
      if (!fp) {
        // Ambiguous name -> leave alone and ask a human. Genuinely absent from the
        // league's player list -> the player has left; drop them from the squad.
        if (findPlayers(p.name, players).length > 1) {
          log.review.push({ club: club.name, player: p.name, reason: 'Ambiguous name - several FPL players match. Fix in Transfer desk.' });
          return;
        }
        if (squads.tiersLocked && p.listed) {
          // On your squad list but not found in FPL: keep him and ask, never delete.
          log.review.push({ club: club.name, player: p.name, reason: 'On the squad list but not found in FPL data - kept. Check spelling or remove if he has left.' });
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

  applySquadRules(squads, players, clubOf, log);
  // Re-derive the tier arrays.
  rebuildTiers(squads, log);

  squads.generated = log.generated;
  return log;
}

/* ---- match results (for the position history) -----------------------------
 * Normalised result rows: { home, away, hs, as, kickoff } with FPL team ids. */
function fplResults(fixtures) {
  return (fixtures || []).filter(f => f.finished && f.team_h_score !== null && f.kickoff_time)
    .map(f => ({ home: f.team_h, away: f.team_a, hs: f.team_h_score, as: f.team_a_score, kickoff: f.kickoff_time }));
}

/* ESPN scoreboard - an independent results source used when FPL's scores
 * don't reproduce the live table. */
async function espnResults(teams, fromIso) {
  const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');
  const from = new Date(fromIso || Date.now() - 300 * 864e5);
  from.setUTCDate(from.getUTCDate() - 3);
  const j = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard?dates=${ymd(from)}-${ymd(new Date())}&limit=1000`);
  if (!j || !Array.isArray(j.events)) return null;
  const byKey = new Map(teams.map(t => [clubKey(t.name), t.id]));
  const idOf = tm => [tm.displayName, tm.shortDisplayName, tm.name, tm.abbreviation].filter(Boolean).map(clubKey).map(k => byKey.get(k)).find(Boolean);
  const rows = [];
  for (const ev of j.events) {
    const c = ev.competitions && ev.competitions[0];
    if (!c || !(c.status || ev.status || {}).type || !((c.status || ev.status).type.completed)) continue;
    const h = c.competitors.find(x => x.homeAway === 'home'), a = c.competitors.find(x => x.homeAway === 'away');
    const hid = h && idOf(h.team), aid = a && idOf(a.team);
    if (!hid || !aid) { console.warn(`espn results - unmatched club in ${ev.name}`); return null; }
    rows.push({ home: hid, away: aid, hs: +h.score, as: +a.score, kickoff: ev.date });
  }
  return rows;
}

/* League table from results kicked off before `cutoff` (ISO; null = all). */
function tableFrom(results, teams, cutoff) {
  const fx = results.filter(r => !cutoff || new Date(r.kickoff) < new Date(cutoff))
    .map(r => ({ finished: true, team_h: r.home, team_a: r.away, team_h_score: r.hs, team_a_score: r.as }));
  return computeStandings(fx, teams);
}

/* True when a results-derived table agrees with the live table on every club. */
function agrees(table, live) {
  if (!live) return null;
  const m = new Map(table.map(r => [r.id, r]));
  return live.every(l => { const r = m.get(l.id); return r && r.played === l.played && r.points === l.points && r.gd === l.gd; });
}

/* ---- gameweek history ------------------------------------------------------
 * League positions are FACTS, so they are rebuilt every night for EVERY
 * finished gameweek from the actual results: the table after GW n counts every
 * match kicked off before the GW n+1 deadline (postponed games land in the
 * week they were actually played, exactly like the real table). Before the
 * history is written, the same results must reproduce today's live table -
 * so the past positions are only trusted when the present one checks out.
 *
 * WIscore can't be reconstructed after the fact (FPL doesn't publish past
 * injury lists), so recorded values are kept and only the newest finished
 * gameweek gets a fresh one. Gameweeks the job missed get positions but a
 * blank WIscore rather than an invented one. */
async function rebuildHistory(hist, squads, data, players, teams, fixtures, live) {
  const events = (data.events || []).slice().sort((a, b) => a.id - b.id);
  const finished = events.filter(e => e.finished && e.data_checked).map(e => e.id);
  const latest = finished[finished.length - 1];
  const h = hist && Array.isArray(hist.gameweeks) ? hist : { season: '26/27', verified: true, gameweeks: [], clubs: {} };
  if (!latest) return { hist: h, added: null, source: null };

  let results = fplResults(fixtures), source = 'fpl-results';
  let check = agrees(tableFrom(results, teams, null), live);
  if (check === false) {
    const alt = await espnResults(teams, events[0] && events[0].deadline_time);
    if (alt && agrees(tableFrom(alt, teams, null), live)) { results = alt; source = 'espn-results'; check = true; }
    else console.warn('position history - neither FPL nor ESPN results reproduce the live table; recording best available and flagging it.');
  }

  const cutoffOf = id => { const nx = events.find(e => e.id === id + 1); return nx ? nx.deadline_time : null; };
  const posByGw = new Map(finished.map(id => {
    const t = tableFrom(results, teams, cutoffOf(id));
    return [id, new Map(t.map(r => [r.id, r.position]))];
  }));
  // The latest gameweek uses the live table itself when there is one.
  if (live && check !== false && !cutoffOf(latest)) posByGw.set(latest, new Map(live.map(r => [r.id, r.position])));

  const oldGws = h.gameweeks.slice();
  const added = finished.filter(g => !oldGws.includes(g));
  const clubs = {};
  squads.clubs.forEach(club => {
    const t = teams.find(t => t.name === club.name || t.short_name === club.short);
    const old = h.clubs[club.name] || { wiscore: [], league_position: [] };
    const wi = finished.map(g => {
      const i = oldGws.indexOf(g);
      if (i >= 0 && old.wiscore[i] != null) return old.wiscore[i];
      return g === latest ? clubWIscore(club, players, teams, squads.tierWeights) : null;
    });
    const lp = finished.map(g => (t && posByGw.get(g).get(t.id)) || null);
    clubs[club.name] = { ...old, wiscore: wi, league_position: lp };
  });

  h.gameweeks = finished;
  h.clubs = clubs;
  h.verified_through = latest;
  h.positions_source = source;
  h.positions_verified = check !== false;
  h.updated = new Date().toISOString();
  return { hist: h, added: added.length ? added : null, source };
}

async function main() {
  const res = await fetch(FPL_URL, { headers: { 'User-Agent': 'wiscore-app/1.0' } });
  if (!res.ok) throw new Error(`FPL API request failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const fxRes = await fetch(FIXTURES_URL, { headers: { 'User-Agent': 'wiscore-app/1.0' } });
  const fixtures = fxRes.ok ? await fxRes.json() : [];

  const rawTeams = (data.teams || []).map(t => ({ id: t.id, code: t.code, name: t.name, short_name: t.short_name }));
  const computed = computeStandings(fixtures, rawTeams);
  const live = mapLiveTable(await fetchLiveTable(), rawTeams);
  const standings = live || computed;
  const standingsSource = live ? (process.env.FOOTBALL_DATA_KEY ? 'football-data.org' : 'espn') : 'fpl-fixtures';
  console.log(`league table - ${standingsSource}` + (live ? '' : ' (live sources unavailable, using FPL fixtures)'));
  const stand = new Map(standings.map(s => [s.id, s]));
  const teams = rawTeams.map(t => {
    const s = stand.get(t.id) || {};
    return { ...t, position: s.position ?? null, played: s.played ?? 0, points: s.points ?? 0, gd: s.gd ?? 0 };
  });
  const players = (data.elements || []).map(p => ({
    id: p.id, web_name: p.web_name, first_name: p.first_name, second_name: p.second_name,
    team: p.team, status: p.status, chance_this: p.chance_of_playing_this_round,
    chance_next: p.chance_of_playing_next_round, news: p.news || '',
    element_type: p.element_type, price: p.now_cost != null ? p.now_cost / 10 : null, tp: p.total_points ?? null,
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
    standings_source: standingsSource,
    standings_updated: new Date().toISOString(),
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
    if (log.renamed.length) console.log(`squads.json - fixed ${log.renamed.length} spellings to FPL names: ${log.renamed.map(r => `${r.from} -> ${r.to} (${r.club})`).join(', ')}`);
    const unmatched = log.review.filter(r => /not found in FPL|Spelling check/.test(r.reason));
    console.log(unmatched.length ? `squads.json - ${unmatched.length} names still need a look: ${unmatched.map(r => `${r.player} (${r.club})`).join(', ')}` : 'squads.json - every listed player matched to FPL.');
    console.log(`squads.json - ${log.squadRules.locked ? 'tiers locked to your squad list, ' : ''}squad rules ${log.squadRules.maxSquad} max / ${log.squadRules.firstChoice} first choice / ${log.squadRules.firstSub} first sub: ` +
      `${log.added.length} added, ${log.retiered.length} re-tiered, ${log.trimmed.length} trimmed.`);
    if (log.added.length) console.log(`  added: ${log.added.map(a => `${a.player} (${a.club}, ${TIER_LABEL[a.tier]})`).join(', ')}`);
    squads.clubs.forEach(c => console.log(`  ${c.short}: ${c.players.length} players - ${['best', 'first', 'sub', 'youth'].map(t => c.players.filter(p => p.tier === t).length).join('/')}`));
    console.log(`transfers.json - ${log.moves.length} moved, ${log.out.length} removed, ${log.arrivals.length} arrivals to weight, ${log.review.length} to review.`);

    const r = await rebuildHistory(hist, squads, data, players, rawTeams, fixtures, live);
    hist = r.hist;
    writeJson('gameweek-history.json', hist);
    console.log(`gameweek-history.json - positions rebuilt for GW${hist.gameweeks[0] ?? '-'}-${hist.verified_through ?? '-'} from ${r.source}` +
      (hist.positions_verified ? ' (matches live table)' : ' (NOT verified against live table)') +
      (r.added ? `, added GW${r.added.join(', GW')}.` : '.'));
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

#!/usr/bin/env node
/**
 * Transfer-feed reader for WIscore.
 *
 * Reads a published transfer tracker (default: the Guardian's summer-2026
 * men's transfer-window interactive) and normalises it into rows of
 *   { player, from, to, fee, date }
 * so scripts/fetch-fpl.js can act on confirmed deals the same night they are
 * published, instead of waiting for the FPL API to flag the player.
 *
 * The interactive is rendered from a JSON payload; this module finds that
 * payload (docsdata / gsheet / embedded JSON), and falls back to parsing the
 * article HTML if the shape changes. Only factual deal fields are read.
 *
 * Set TRANSFER_FEED_URL to point at a different tracker.
 * Exports: loadTransferFeed()  ->  { source, fetched_at, rows[], error }
 */
const FEED_URL = process.env.TRANSFER_FEED_URL
  || 'https://www.theguardian.com/football/ng-interactive/2026/jun/08/mens-transfer-window-summer-2026-all-deals-from-europes-top-five-leagues';

const UA = 'Mozilla/5.0 (compatible; wiscore-bot/1.0; +https://wiscore.co)';
const get = async (url, type = 'text') => {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
  return type === 'json' ? r.json() : r.text();
};

const clean = s => (s || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'")
  .replace(/&nbsp;/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();

/* Any of these keys, whatever the sheet's column casing, map to our fields. */
const FIELD = {
  player: ['player', 'name', 'playername', 'player_name'],
  from: ['from', 'fromclub', 'selling', 'sellingclub', 'oldclub', 'leaving', 'previousclub'],
  to: ['to', 'toclub', 'buying', 'buyingclub', 'newclub', 'joining', 'destination'],
  fee: ['fee', 'price', 'cost', 'amount'],
  date: ['date', 'announced', 'confirmed', 'day'],
};
const pick = (obj, keys) => {
  const map = new Map(Object.keys(obj).map(k => [k.toLowerCase().replace(/[^a-z_]/g, ''), k]));
  for (const k of keys) { const real = map.get(k); if (real && obj[real] != null && String(obj[real]).trim()) return clean(String(obj[real])); }
  return '';
};
const toRow = o => {
  const row = { player: pick(o, FIELD.player), from: pick(o, FIELD.from), to: pick(o, FIELD.to), fee: pick(o, FIELD.fee), date: pick(o, FIELD.date) };
  return (row.player && (row.from || row.to)) ? row : null;
};

/* Walk any JSON payload and harvest every object that looks like a deal. */
function harvest(node, out = [], depth = 0) {
  if (!node || depth > 8 || out.length > 5000) return out;
  if (Array.isArray(node)) { node.forEach(n => harvest(n, out, depth + 1)); return out; }
  if (typeof node !== 'object') return out;
  const row = toRow(node);
  if (row) out.push(row);
  Object.values(node).forEach(v => { if (v && typeof v === 'object') harvest(v, out, depth + 1); });
  return out;
}

/* Data URLs the Guardian's interactives load their rows from. */
function dataUrls(html) {
  const urls = new Set();
  const re = /https?:\/\/[^"'\s\\)]+?(?:docsdata[^"'\s\\)]*|gsheet[^"'\s\\)]*|\.json)/gi;
  (html.match(re) || []).forEach(u => {
    const url = u.replace(/\\u002F/gi, '/').replace(/\\/g, '');
    if (/interactive|guim|gutools|docsdata|gsheet/i.test(url)) urls.add(url);
  });
  return [...urls].slice(0, 8);
}

/* Last resort: read the rendered table/list out of the HTML itself. */
function parseHtml(html) {
  const rows = [];
  const cells = tr => (tr.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi) || []).map(clean);
  (html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || []).forEach(tr => {
    const c = cells(tr).filter(Boolean);
    if (c.length >= 3 && !/^player$/i.test(c[0])) rows.push({ player: c[0], from: c[1], to: c[2], fee: c[3] || '', date: c[4] || '' });
  });
  if (rows.length) return rows;
  // "Player, from Club to Club" prose form
  const text = clean(html);
  const re = /([A-Z][\w'’.-]+(?:\s+[A-Z][\w'’.-]+){0,3})\s*[,(]?\s*from\s+([A-Z][\w'’.& -]{2,30}?)\s+to\s+([A-Z][\w'’.& -]{2,30}?)\s*[,.)]/g;
  let m;
  while ((m = re.exec(text)) && rows.length < 2000) rows.push({ player: m[1], from: m[2], to: m[3], fee: '', date: '' });
  return rows;
}

async function loadTransferFeed(url = FEED_URL) {
  const out = { source: url, fetched_at: new Date().toISOString(), rows: [], error: null };
  try {
    const html = await get(url);

    // 1. JSON payloads embedded in the page.
    for (const m of html.matchAll(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi)) {
      try { harvest(JSON.parse(m[1]), out.rows); } catch { /* not our payload */ }
    }

    // 2. External data files the interactive fetches.
    if (out.rows.length < 5) {
      for (const u of dataUrls(html)) {
        try { harvest(await get(u, 'json'), out.rows); } catch { /* skip */ }
        if (out.rows.length > 20) break;
      }
    }

    // 3. Rendered HTML.
    if (out.rows.length < 5) out.rows.push(...parseHtml(html));

    // De-duplicate on player+from+to.
    const seen = new Set();
    out.rows = out.rows.filter(r => {
      const k = `${r.player}|${r.from}|${r.to}`.toLowerCase();
      if (seen.has(k)) return false; seen.add(k); return true;
    });
    if (!out.rows.length) out.error = 'Feed reachable but no deal rows recognised - check the tracker layout.';
  } catch (err) {
    out.error = String(err.message || err);
  }
  return out;
}

module.exports = { loadTransferFeed, FEED_URL };

if (require.main === module) {
  loadTransferFeed().then(f => {
    console.log(f.error ? `feed error: ${f.error}` : `feed: ${f.rows.length} deals from ${f.source}`);
    f.rows.slice(0, 15).forEach(r => console.log(` - ${r.player}: ${r.from || '?'} -> ${r.to || '?'} ${r.fee || ''}`));
  });
}

/**
 * WIscore publish endpoint.
 *
 * The admin panel POSTs a JSON file here and this function commits it to the
 * GitHub repo, which triggers a normal Netlify deploy. The GitHub token lives
 * in Netlify's environment, never in the browser.
 *
 * Netlify environment variables required:
 *   GITHUB_TOKEN   fine-grained PAT, repo Contents: read & write
 *   GITHUB_REPO    e.g. "yourname/wiscore"
 *   GITHUB_BRANCH  optional, defaults to "main"
 *   ADMIN_SECRET   passphrase the admin panel sends with each publish
 *
 * POST body: { path, content, message, secret }
 *   path     one of the allowed data files below
 *   content  the file body as a string (pretty-printed JSON)
 */
const ALLOWED = new Set([
  'public/squads.json',
  'public/fpl-data.json',
  'public/insights.json',
  'public/squad-alerts.json',
  'public/fixtures.json',
  'public/transfers.json',
  'public/gameweek-history.json',
]);

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: { Allow: 'POST' }, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  const { GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH = 'main', ADMIN_SECRET } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_REPO) return json(500, { error: 'GITHUB_TOKEN / GITHUB_REPO not configured on Netlify.' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Body is not JSON.' }); }
  const { path, content, message, secret } = body;

  if (ADMIN_SECRET && secret !== ADMIN_SECRET) return json(401, { error: 'Wrong publish passphrase.' });
  if (!ALLOWED.has(path)) return json(400, { error: `Path not allowed: ${path}` });
  if (typeof content !== 'string' || !content.trim()) return json(400, { error: 'Empty content.' });
  try { JSON.parse(content); } catch { return json(400, { error: 'Content is not valid JSON - nothing committed.' }); }

  const api = `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`;
  const headers = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'wiscore-admin',
    'Content-Type': 'application/json',
  };

  try {
    // Current blob sha (absent on first write).
    let sha;
    const head = await fetch(`${api}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, { headers });
    if (head.ok) sha = (await head.json()).sha;
    else if (head.status !== 404) return json(head.status, { error: `GitHub read failed: ${head.status} ${head.statusText}` });

    const put = await fetch(api, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: message || `admin: update ${path}`,
        content: Buffer.from(content, 'utf8').toString('base64'),
        branch: GITHUB_BRANCH,
        ...(sha ? { sha } : {}),
      }),
    });
    const out = await put.json();
    if (!put.ok) return json(put.status, { error: out.message || `GitHub write failed: ${put.status}` });

    return json(200, {
      ok: true,
      path,
      commit: out.commit && out.commit.sha,
      url: out.commit && out.commit.html_url,
      committed_at: new Date().toISOString(),
    });
  } catch (err) {
    return json(502, { error: String(err.message || err) });
  }
};

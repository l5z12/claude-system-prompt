// Cloudflare Worker: JSON API over the bundled archive + static UI via Assets.
//   GET /api/tree                          -> light surface/model/block tree
//   GET /api/file?path=...                 -> one block (with content)
//   GET /api/search?q=...&surface=code     -> server-side line search
//   GET /api/diff?left=...&right=...        -> line diff between two blocks
// Anything else falls through to the static assets in ./public.
import archive from 'virtual:archive';

const FILES = archive.files;
const BY_PATH = new Map(FILES.map((f) => [f.path, f]));

const TREE = (() => {
  const t = {};
  for (const f of FILES) {
    (t[f.surface] ??= {});
    (t[f.surface][f.model] ??= []).push({ path: f.path, file: f.file, name: f.name, order: f.order });
  }
  return t;
})();

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// Line-level diff via longest-common-subsequence backtrack.
function diffLines(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0, add = 0, del = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) ops.push({ t: ' ', a: i + 1, b: j + 1, text: a[i++] }), j++;
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ t: '-', a: ++i, text: a[i - 1] }), del++;
    else ops.push({ t: '+', b: ++j, text: b[j - 1] }), add++;
  }
  while (i < m) ops.push({ t: '-', a: ++i, text: a[i - 1] }), del++;
  while (j < n) ops.push({ t: '+', b: ++j, text: b[j - 1] }), add++;
  return { ops, add, del };
}

function search(q, surface) {
  const needle = q.toLowerCase();
  const results = [];
  let totalMatches = 0;
  for (const f of FILES) {
    if (surface && f.surface !== surface) continue;
    const lines = f.content.split('\n');
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) hits.push({ line: i + 1, text: lines[i] });
    }
    if (hits.length) {
      totalMatches += hits.length;
      results.push({
        path: f.path, surface: f.surface, model: f.model, file: f.file, name: f.name,
        hitCount: hits.length, hits: hits.slice(0, 20),
      });
    }
  }
  results.sort((x, y) => y.hitCount - x.hitCount || x.path.localeCompare(y.path));
  return { totalMatches, fileCount: results.length, results: results.slice(0, 100) };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (p === '/api/tree') {
      return json({ generatedAt: archive.generatedAt, count: FILES.length, tree: TREE });
    }
    if (p === '/api/file') {
      const f = BY_PATH.get(url.searchParams.get('path') || '');
      return f ? json(f) : json({ error: 'file not found' }, 404);
    }
    if (p === '/api/search') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return json({ error: 'empty query' }, 400);
      return json({ q, ...search(q, url.searchParams.get('surface') || '') });
    }
    if (p === '/api/diff') {
      const left = BY_PATH.get(url.searchParams.get('left') || '');
      const right = BY_PATH.get(url.searchParams.get('right') || '');
      if (!left || !right) return json({ error: 'left and right must both be valid paths' }, 400);
      const { ops, add, del } = diffLines(left.content.split('\n'), right.content.split('\n'));
      return json({ left: left.path, right: right.path, add, del, same: left.content === right.content, ops });
    }
    if (p.startsWith('/api/')) return json({ error: 'unknown endpoint' }, 404);

    // Static UI.
    return env.ASSETS.fetch(request);
  },
};

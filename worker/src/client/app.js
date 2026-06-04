import './style.css';
import { marked } from 'marked';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const api = (path) => fetch(path).then((r) => r.json());
const REPO = 'https://github.com/l5z12/claude-system-prompt';
const RAW = 'https://raw.githubusercontent.com/l5z12/claude-system-prompt/HEAD';
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

let TREE = {};      // { surface: { model: [ {path,file,name,order} ] } }
let FILES = [];     // flattened: { surface, model, path, file, name, order }
let SKILLS = [];    // [ {id, source, name, description, fileCount} ]
let skillState = null; // open skill: { id, name, source, description, files, dir:[], file }
let activePath = null;

// ---------- routing ----------
// The URL hash is the source of truth: UI actions call setHash(), and router()
// applies the resulting state. This gives shareable URLs + working back/forward.
function setHash(h) {
  const target = '#' + h;
  if (location.hash === target) router();
  else location.hash = target;
}

function router() {
  const h = location.hash.slice(1).replace(/^\//, '');
  const qIdx = h.indexOf('?');
  const pathPart = qIdx === -1 ? h : h.slice(0, qIdx);
  const params = new URLSearchParams(qIdx === -1 ? '' : h.slice(qIdx + 1));
  const segs = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  const tab = segs[0] || 'browse';
  if (tab === 'search') applySearch(params.get('q') || '', params.get('surface') || '');
  else if (tab === 'diff') applyDiff(params.get('left') || '', params.get('right') || '');
  else if (tab === 'skills') applySkills(segs.slice(1));
  else applyBrowse(segs.slice(1).join('/'));
}

function showTab(name) {
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const s of document.querySelectorAll('.tab')) s.classList.toggle('hidden', s.id !== 'tab-' + name);
}

// Tab buttons navigate to that tab, preserving its current selection/params.
for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => setHash(tabHash(b.dataset.tab)));

function tabHash(tab) {
  if (tab === 'search') { const qs = searchQS(); return qs ? 'search?' + qs : 'search'; }
  if (tab === 'diff') { const qs = diffQS(); return qs ? 'diff?' + qs : 'diff'; }
  if (tab === 'skills') return skillState ? skillHash(skillState.id, skillState.file || skillState.dir.join('/')) : 'skills';
  return activePath ? 'browse/' + encPath(activePath) : 'browse';
}

// ---------- init ----------
(async function init() {
  const [data, sk] = await Promise.all([
    api('/api/tree'),
    api('/api/skills').catch(() => ({ skills: [] })),
  ]);
  TREE = data.tree;
  FILES = [];
  for (const surface of Object.keys(TREE)) {
    for (const model of Object.keys(TREE[surface])) {
      for (const blk of TREE[surface][model]) FILES.push({ surface, model, ...blk });
    }
  }
  SKILLS = sk.skills || [];
  const when = data.generatedAt ? new Date(data.generatedAt).toLocaleString() : '';
  $('#meta').textContent = `${data.count} blocks · ${SKILLS.length} skills · built ${when}`;
  renderTree();
  fillPickers();
  renderSkillsList();
  window.addEventListener('hashchange', router);
  router();
})();

// ---------- browse ----------
// Recursive directory tree over the real archive paths (a proper file explorer).
function renderTree() {
  const root = $('#tree');
  root.innerHTML = '';
  const tree = {};
  for (const f of FILES) {
    const parts = f.path.split('/');
    let node = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      node.dirs ??= {};
      node = node.dirs[parts[i]] ??= {};
    }
    (node.files ??= []).push(f);
  }
  renderDir(tree, root, 0);
}

function renderDir(node, container, depth) {
  for (const name of Object.keys(node.dirs || {}).sort()) {
    const det = document.createElement('details');
    det.className = 'tree-dir';
    if (depth === 0) det.open = true;
    const sum = document.createElement('summary');
    sum.textContent = name;
    det.appendChild(sum);
    const kids = document.createElement('div');
    kids.className = 'tree-kids';
    renderDir(node.dirs[name], kids, depth + 1);
    det.appendChild(kids);
    container.appendChild(det);
  }
  const files = (node.files || []).sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a.file.localeCompare(b.file));
  for (const f of files) {
    const a = document.createElement('div');
    a.className = 'block-link';
    a.dataset.path = f.path;
    a.innerHTML = `<span class="fname">${esc(f.file)}</span>`;
    a.addEventListener('click', () => setHash('browse/' + encPath(f.path)));
    container.appendChild(a);
  }
}

function applyBrowse(path) {
  showTab('browse');
  if (!path) {
    activePath = null;
    $('#tab-browse').classList.remove('viewing');
    for (const el of document.querySelectorAll('.block-link')) el.classList.remove('active');
    $('#browse-head').classList.add('hidden');
    $('#browse-body').textContent = 'Select a block from the tree.';
    return;
  }
  loadBlock(path);
}

async function loadBlock(path) {
  $('#tab-browse').classList.add('viewing'); // mobile: show detail
  activePath = path;
  for (const el of document.querySelectorAll('.block-link')) el.classList.toggle('active', el.dataset.path === path);
  const link = document.querySelector(`.block-link[data-path="${cssEscape(path)}"]`);
  if (link) {
    for (let n = link.parentElement; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true;
    link.scrollIntoView({ block: 'nearest' });
  }
  $('#browse-head').classList.remove('hidden');
  $('#browse-path').textContent = path;
  $('#browse-gh').href = `${REPO}/blob/HEAD/${encPath(path)}`;
  const body = $('#browse-body');
  body.textContent = 'loading…';
  const f = await api('/api/file?path=' + encodeURIComponent(path));
  if (f.error) { body.textContent = '(not found)'; return; }
  if (f.binary) {
    $('#browse-raw').classList.add('hidden');
    $('#browse-diff').classList.add('hidden');
    const url = `${RAW}/${encPath(path)}`;
    body.innerHTML =
      `<div class="binnote"><div>Unparsable file (binary or &gt; 2&nbsp;MB) — ${fmtSize(f.size)}.</div>` +
      `<div class="binnote-actions">` +
      `<a class="ghost" href="${url}" target="_blank" rel="noopener">Show raw ↗</a>` +
      `<a class="ghost" href="${url}" download="${esc(path.split('/').pop())}">Download</a>` +
      `</div></div>`;
    return;
  }
  $('#browse-raw').classList.remove('hidden');
  $('#browse-diff').classList.remove('hidden');
  $('#browse-raw').href = '/raw?path=' + encodeURIComponent(path);
  if (/\.md$/i.test(path)) {
    body.innerHTML = `<div class="markdown">${marked.parse(stripFrontmatter(f.content))}</div>`;
  } else {
    body.innerHTML = '';
    const pre = document.createElement('pre');
    pre.className = 'raw';
    pre.textContent = f.content;
    body.appendChild(pre);
  }
}

$('#browse-back').addEventListener('click', () => setHash('browse'));

$('#browse-diff').addEventListener('click', () => {
  if (!activePath) return;
  const cur = FILES.find((f) => f.path === activePath);
  if (!cur) return;
  // prefer a sibling: same surface + same block name, different path
  const sib = FILES.find((f) => !f.bin && f.surface === cur.surface && f.name === cur.name && f.path !== cur.path);
  setHash('diff?' + new URLSearchParams({ left: cur.path, right: sib ? sib.path : cur.path }).toString());
});

// ---------- search ----------
let searchTimer = null;
$('#search-input').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(syncSearch, 180);
});
$('#search-surface').addEventListener('change', syncSearch);

function searchQS() {
  const qs = new URLSearchParams();
  const q = $('#search-input').value.trim();
  const surface = $('#search-surface').value;
  if (q) qs.set('q', q);
  if (surface) qs.set('surface', surface);
  return qs.toString();
}

// Keystrokes update the URL in place (no history spam) and run the search.
function syncSearch() {
  runSearch();
  const qs = searchQS();
  history.replaceState(null, '', '#search' + (qs ? '?' + qs : ''));
}

function applySearch(q, surface) {
  showTab('search');
  $('#search-input').value = q;
  $('#search-surface').value = surface || '';
  runSearch();
}

async function runSearch() {
  const q = $('#search-input').value.trim();
  const surface = $('#search-surface').value;
  const status = $('#search-status');
  const out = $('#search-results');
  if (!q) { status.textContent = ''; out.innerHTML = ''; return; }
  status.textContent = 'searching…';
  const data = await api('/api/search?q=' + encodeURIComponent(q) + (surface ? '&surface=' + surface : ''));
  if (data.error) { status.textContent = data.error; out.innerHTML = ''; return; }
  status.textContent = `${data.totalMatches} match(es) in ${data.fileCount} block(s)` + (data.fileCount >= 100 ? ' (showing first 100)' : '');
  const re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
  out.innerHTML = '';
  for (const r of data.results) {
    const div = document.createElement('div');
    div.className = 'result';
    const lines = r.hits
      .map((h) => `<div class="hitline"><span class="ln">${h.line}</span><span>${esc(h.text).replace(re, '<mark>$1</mark>')}</span></div>`)
      .join('');
    const more = r.hitCount > r.hits.length ? `<div class="hitline"><span class="ln"></span><span class="rc">…${r.hitCount - r.hits.length} more</span></div>` : '';
    div.innerHTML = `<div class="result-head"><span class="rp">${esc(r.path)}</span><span class="rc">${r.hitCount}×</span></div>${lines}${more}`;
    div.querySelector('.result-head').addEventListener('click', () => setHash('browse/' + encPath(r.path)));
    out.appendChild(div);
  }
}

// ---------- diff ----------
function fillPickers() {
  const opts = optionsHtml();
  $('#diff-left').innerHTML = opts;
  $('#diff-right').innerHTML = opts;
  // sensible default: same block name across two models if possible
  const tf = FILES.filter((f) => !f.bin);
  if (tf.length >= 2) {
    $('#diff-left').value = tf[0].path;
    const sib = tf.find((f) => f.surface === tf[0].surface && f.name === tf[0].name && f.path !== tf[0].path) || tf[1];
    $('#diff-right').value = sib.path;
  }
  $('#diff-left').addEventListener('change', syncDiff);
  $('#diff-right').addEventListener('change', syncDiff);
  $('#diff-swap').addEventListener('click', () => {
    const l = $('#diff-left').value;
    $('#diff-left').value = $('#diff-right').value;
    $('#diff-right').value = l;
    syncDiff();
  });
}

function diffQS() {
  const left = $('#diff-left').value;
  const right = $('#diff-right').value;
  if (!left || !right) return '';
  return new URLSearchParams({ left, right }).toString();
}

function syncDiff() {
  const qs = diffQS();
  setHash(qs ? 'diff?' + qs : 'diff');
}

function applyDiff(left, right) {
  showTab('diff');
  if (left) $('#diff-left').value = left;
  if (right) $('#diff-right').value = right;
  runDiff();
}

function optionsHtml() {
  let html = '';
  let group = null;
  for (const f of FILES) {
    if (f.bin) continue;
    const g = `${f.surface} / ${f.model}`;
    if (g !== group) {
      if (group !== null) html += '</optgroup>';
      html += `<optgroup label="${esc(g)}">`;
      group = g;
    }
    html += `<option value="${esc(f.path)}">${esc(f.file)}</option>`;
  }
  if (group !== null) html += '</optgroup>';
  return html;
}

async function runDiff() {
  const left = $('#diff-left').value;
  const right = $('#diff-right').value;
  const status = $('#diff-status');
  const out = $('#diff-output');
  if (!left || !right) return;
  status.textContent = 'diffing…';
  const d = await api('/api/diff?left=' + encodeURIComponent(left) + '&right=' + encodeURIComponent(right));
  if (d.error) { status.textContent = d.error; out.innerHTML = ''; return; }
  if (d.same) {
    status.textContent = 'identical';
    out.innerHTML = '<div class="empty">The two blocks are byte-identical.</div>';
    return;
  }
  status.textContent = `+${d.add} −${d.del}  ·  ${esc(left)} → ${esc(right)}`;
  out.innerHTML = d.ops.map(renderRow).join('');
}

function renderRow(op) {
  const cls = op.t === '+' ? 'add' : op.t === '-' ? 'del' : 'ctx';
  const sign = op.t === ' ' ? '' : op.t;
  const gut = `<span class="gut"><span class="n">${op.a ?? ''}</span><span class="n">${op.b ?? ''}</span></span>`;
  return `<div class="drow ${cls}">${gut}<span class="sign">${sign}</span><span class="txt">${esc(op.text) || ' '}</span></div>`;
}

// CSS.escape fallback for attribute selectors with special chars (e.g. [1m]).
function cssEscape(s) {
  return window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/["\\\]\[]/g, '\\$&');
}

// ---------- skills ----------
$('#skill-filter').addEventListener('input', renderSkillsList);
$('#skill-back').addEventListener('click', () => setHash('skills'));

function skillHash(id, sub) {
  return 'skills/' + encPath(id) + (sub ? '/' + encPath(sub) : '');
}

function renderSkillsList() {
  const q = $('#skill-filter').value.trim().toLowerCase();
  const root = $('#skills-list');
  root.innerHTML = '';
  for (const source of ['public', 'examples']) {
    const list = SKILLS.filter(
      (s) => s.source === source && (!q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
    );
    if (!list.length) continue;
    const g = document.createElement('div');
    g.className = 'surface-group';
    g.innerHTML = `<div class="group-label">${esc(source)} · ${list.length}</div>`;
    for (const s of list) {
      const it = document.createElement('div');
      it.className = 'skill-link';
      it.dataset.id = s.id;
      it.innerHTML = `<div class="sk-name">${esc(s.name)}</div><div class="sk-desc">${esc(s.description)}</div>`;
      it.addEventListener('click', () => setHash(skillHash(s.id, '')));
      g.appendChild(it);
    }
    root.appendChild(g);
  }
  if (!root.children.length) root.innerHTML = '<div class="status">No skills match.</div>';
}

async function applySkills(rest) {
  showTab('skills');
  if (rest.length < 2) {
    skillState = null;
    $('#tab-skills').classList.remove('viewing');
    $('#skill-head').classList.add('hidden');
    $('#skill-detail').innerHTML = '<p class="empty">Select a skill from the list.</p>';
    for (const el of document.querySelectorAll('.skill-link')) el.classList.remove('active');
    return;
  }
  const id = rest[0] + '/' + rest[1];
  const subPath = rest.slice(2).join('/');
  if (!skillState || skillState.id !== id) {
    const s = await api('/api/skill?id=' + encodeURIComponent(id));
    if (s.error) {
      $('#skill-head').classList.add('hidden');
      $('#skill-detail').innerHTML = '<p class="empty">Skill not found.</p>';
      return;
    }
    skillState = { ...s, dir: [], file: null };
  }
  $('#tab-skills').classList.add('viewing');
  $('#skill-head').classList.remove('hidden');
  $('#skill-title').textContent = skillState.name;
  $('#skill-source').textContent = skillState.source;
  for (const el of document.querySelectorAll('.skill-link')) el.classList.toggle('active', el.dataset.id === id);
  if (subPath && skillState.files.some((f) => f.path === subPath)) {
    skillState.file = subPath;
    skillState.dir = subPath.split('/').slice(0, -1);
  } else {
    skillState.file = null;
    skillState.dir = subPath ? subPath.split('/') : [];
  }
  renderSkill();
}

function renderSkill() {
  const s = skillState;
  const detail = $('#skill-detail');
  // GitHub + Raw links track the current location (file = blob/raw, dir = tree)
  const sub = s.file || s.dir.join('/');
  const repoPath = 'web/skills/' + s.id + (sub ? '/' + sub : '');
  $('#skill-gh').href = `${REPO}/${s.file ? 'blob' : 'tree'}/HEAD/${encPath(repoPath)}`;
  const readmeFile = s.files.find((f) => f.path.toLowerCase() === 'skill.md');
  const rawEl = $('#skill-raw');
  // Raw targets the open file, or SKILL.md when showing the skill's README.
  const rawPath = s.file || (!s.dir.length && readmeFile ? readmeFile.path : null);
  if (rawPath) {
    rawEl.href = skillFileUrl(rawPath);
    rawEl.classList.remove('hidden');
  } else {
    rawEl.classList.add('hidden');
  }
  const crumbs = [`<span class="crumb" data-depth="0">${esc(s.name)}</span>`];
  s.dir.forEach((seg, i) => crumbs.push(`<span class="crumb" data-depth="${i + 1}">${esc(seg)}</span>`));
  if (s.file) crumbs.push(`<span class="crumb-file">${esc(s.file.split('/').pop())}</span>`);
  const breadcrumb = `<div class="crumbs">${crumbs.join('<span class="sep">/</span>')}</div>`;
  const body = s.file ? '<div class="file-view" id="file-view">loading…</div>' : renderDirListing(s);
  const meta =
    (s.description ? `<p class="skill-desc">${esc(s.description)}</p>` : '') +
    (s.license ? `<p class="skill-license">License — ${esc(s.license)}</p>` : '');
  detail.innerHTML = meta + breadcrumb + body;
  detail.scrollTop = 0;

  detail.querySelectorAll('.crumb').forEach((el) =>
    el.addEventListener('click', () => {
      const dirPath = skillState.dir.slice(0, +el.dataset.depth).join('/');
      setHash(skillHash(skillState.id, dirPath));
    })
  );
  if (s.file) {
    loadFile(s.file);
    return;
  }
  detail.querySelectorAll('.entry').forEach((el) =>
    el.addEventListener('click', () => {
      const target = el.dataset.dir ? skillState.dir.concat(el.dataset.dir).join('/') : el.dataset.file;
      setHash(skillHash(skillState.id, target));
    })
  );
  if (!s.dir.length && readmeFile) loadReadme(readmeFile.path);
}

function renderDirListing(s) {
  const prefix = s.dir.length ? s.dir.join('/') + '/' : '';
  const dirs = new Set();
  const files = [];
  for (const f of s.files) {
    if (!f.path.startsWith(prefix)) continue;
    const rest = f.path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) files.push({ name: rest, path: f.path, size: f.size });
    else dirs.add(rest.slice(0, slash));
  }
  const di = [...dirs]
    .sort()
    .map((d) => `<div class="entry" data-dir="${esc(d)}"><span class="ic ic-dir"></span><span class="en">${esc(d)}/</span></div>`)
    .join('');
  const fi = files
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((f) => `<div class="entry" data-file="${esc(f.path)}"><span class="ic ic-file"></span><span class="en">${esc(f.name)}</span><span class="sz">${fmtSize(f.size)}</span></div>`)
    .join('');
  const readme = s.dir.length ? '' : '<div class="readme markdown" id="readme"></div>';
  return `<div class="explorer">${di}${fi}</div>${readme}`;
}

function skillFileUrl(path) {
  return '/skills/' + skillState.id + '/' + path.split('/').map(encodeURIComponent).join('/');
}

// Remove a leading YAML frontmatter block so it isn't rendered as markdown.
function stripFrontmatter(md) {
  const m = md.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? md.slice(m[0].length) : md;
}

async function loadReadme(path) {
  const el = document.getElementById('readme');
  if (!el) return;
  try {
    const txt = await fetch(skillFileUrl(path)).then((r) => r.text());
    el.innerHTML = `<div class="readme-head">${esc(path)}</div>` + marked.parse(stripFrontmatter(txt));
  } catch {
    el.remove();
  }
}

async function loadFile(path) {
  const el = document.getElementById('file-view');
  if (!el) return;
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const BIN = new Set(['ttf', 'otf', 'woff', 'woff2', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'zip', 'gz', 'skill']);
  const url = skillFileUrl(path);
  if (BIN.has(ext)) {
    el.innerHTML =
      `<div class="binnote"><div>Binary file (.${esc(ext)}).</div>` +
      `<div class="binnote-actions">` +
      `<a class="ghost" href="${url}" target="_blank" rel="noopener">Show raw ↗</a>` +
      `<a class="ghost" href="${url}" download>Download</a>` +
      `</div></div>`;
    return;
  }
  try {
    const txt = await fetch(url).then((r) => r.text());
    el.innerHTML = ext === 'md' ? `<div class="markdown">${marked.parse(stripFrontmatter(txt))}</div>` : `<pre class="skill-md">${esc(txt)}</pre>`;
  } catch {
    el.innerHTML = '<div class="binnote">Could not load file.</div>';
  }
}

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

// ---------- disclaimer ----------
const disclaimer = $('#disclaimer');
$('#disclaimer-open').addEventListener('click', () => disclaimer.showModal());
disclaimer.addEventListener('close', () => localStorage.setItem('disclaimerAck', '1'));
if (!localStorage.getItem('disclaimerAck')) disclaimer.showModal();

import './style.css';
import { marked } from 'marked';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const api = (path) => fetch(path).then((r) => r.json());
const REPO = 'https://github.com/l5z12/claude-system-prompt';
const ghPath = (p) => p.split('/').map(encodeURIComponent).join('/');

let TREE = {};      // { surface: { model: [ {path,file,name,order} ] } }
let FILES = [];     // flattened: { surface, model, path, file, name, order }
let SKILLS = [];    // [ {id, source, name, description, fileCount} ]
let skillState = null; // open skill: { id, name, source, description, files, dir:[], file }
let activePath = null;

// ---------- tabs ----------
function showTab(name) {
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const s of document.querySelectorAll('.tab')) s.classList.toggle('hidden', s.id !== 'tab-' + name);
}
for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));

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
})();

// ---------- browse ----------
function renderTree() {
  const root = $('#tree');
  root.innerHTML = '';
  for (const surface of Object.keys(TREE)) {
    const sg = document.createElement('div');
    sg.className = 'surface-group';
    sg.innerHTML = `<div class="group-label">${esc(surface)}/</div>`;
    for (const model of Object.keys(TREE[surface])) {
      const det = document.createElement('details');
      det.className = 'model-group';
      const sum = document.createElement('summary');
      sum.textContent = model;
      det.appendChild(sum);
      for (const blk of TREE[surface][model]) {
        const a = document.createElement('div');
        a.className = 'block-link';
        a.dataset.path = blk.path;
        const num = String(blk.order).padStart(2, '0');
        a.innerHTML = `<span><span class="num">${num}</span> ${esc(blk.name)}</span>`;
        a.addEventListener('click', () => openBlock(blk.path));
        det.appendChild(a);
      }
      sg.appendChild(det);
    }
    root.appendChild(sg);
  }
}

async function openBlock(path) {
  showTab('browse');
  $('#tab-browse').classList.add('viewing'); // mobile: show detail, hide tree
  activePath = path;
  for (const el of document.querySelectorAll('.block-link')) el.classList.toggle('active', el.dataset.path === path);
  // make sure its <details> is open
  const link = document.querySelector(`.block-link[data-path="${cssEscape(path)}"]`);
  if (link && link.closest('details')) link.closest('details').open = true;
  const f = await api('/api/file?path=' + encodeURIComponent(path));
  $('#browse-head').classList.remove('hidden');
  $('#browse-path').textContent = path;
  $('#browse-raw').href = '/raw?path=' + encodeURIComponent(path);
  $('#browse-gh').href = `${REPO}/blob/HEAD/${ghPath(path)}`;
  $('#browse-body').textContent = f.content;
}

$('#browse-back').addEventListener('click', () => $('#tab-browse').classList.remove('viewing'));

$('#browse-diff').addEventListener('click', () => {
  if (!activePath) return;
  const cur = FILES.find((f) => f.path === activePath);
  if (!cur) return;
  // prefer a sibling: same surface + same block name, different path
  const sib = FILES.find((f) => f.surface === cur.surface && f.name === cur.name && f.path !== cur.path);
  $('#diff-left').value = cur.path;
  if (sib) $('#diff-right').value = sib.path;
  showTab('diff');
  runDiff();
});

// ---------- search ----------
let searchTimer = null;
$('#search-input').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 180);
});
$('#search-surface').addEventListener('change', runSearch);

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
    div.querySelector('.result-head').addEventListener('click', () => openBlock(r.path));
    out.appendChild(div);
  }
}

// ---------- diff ----------
function fillPickers() {
  const opts = optionsHtml();
  $('#diff-left').innerHTML = opts;
  $('#diff-right').innerHTML = opts;
  // sensible default: same block name across two models if possible
  if (FILES.length >= 2) {
    $('#diff-left').selectedIndex = 0;
    const left = FILES[0];
    const sib = FILES.find((f) => f.surface === left.surface && f.name === left.name && f.path !== left.path) || FILES[1];
    $('#diff-right').value = sib.path;
  }
  $('#diff-left').addEventListener('change', runDiff);
  $('#diff-right').addEventListener('change', runDiff);
  $('#diff-swap').addEventListener('click', () => {
    const l = $('#diff-left').value;
    $('#diff-left').value = $('#diff-right').value;
    $('#diff-right').value = l;
    runDiff();
  });
}

function optionsHtml() {
  let html = '';
  let group = null;
  for (const f of FILES) {
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
  return `<div class="drow ${cls}">${gut}<span class="sign">${sign}</span><span class="txt">${esc(op.text) || ' '}</span></div>`;
}

// CSS.escape fallback for attribute selectors with special chars (e.g. [1m]).
function cssEscape(s) {
  return window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/["\\\]\[]/g, '\\$&');
}

// ---------- skills ----------
$('#skill-filter').addEventListener('input', renderSkillsList);
$('#skill-back').addEventListener('click', () => $('#tab-skills').classList.remove('viewing'));

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
      it.addEventListener('click', () => openSkill(s.id));
      g.appendChild(it);
    }
    root.appendChild(g);
  }
  if (!root.children.length) root.innerHTML = '<div class="status">No skills match.</div>';
}

async function openSkill(id) {
  showTab('skills');
  $('#tab-skills').classList.add('viewing'); // mobile: show detail
  for (const el of document.querySelectorAll('.skill-link')) el.classList.toggle('active', el.dataset.id === id);
  const s = await api('/api/skill?id=' + encodeURIComponent(id));
  if (s.error) return;
  $('#skill-head').classList.remove('hidden');
  $('#skill-title').textContent = s.name;
  $('#skill-source').textContent = s.source;
  skillState = { ...s, dir: [], file: null };
  renderSkill();
}

function renderSkill() {
  const s = skillState;
  const detail = $('#skill-detail');
  // GitHub + Raw links track the current location (file = blob/raw, dir = tree)
  const sub = s.file || s.dir.join('/');
  const repoPath = 'web/skills/' + s.id + (sub ? '/' + sub : '');
  $('#skill-gh').href = `${REPO}/${s.file ? 'blob' : 'tree'}/HEAD/${ghPath(repoPath)}`;
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
      skillState.dir = skillState.dir.slice(0, +el.dataset.depth);
      skillState.file = null;
      renderSkill();
    })
  );
  if (s.file) {
    loadFile(s.file);
    return;
  }
  detail.querySelectorAll('.entry').forEach((el) =>
    el.addEventListener('click', () => {
      if (el.dataset.dir) skillState.dir = skillState.dir.concat(el.dataset.dir);
      else skillState.file = el.dataset.file;
      renderSkill();
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
    el.innerHTML = `<div class="binnote">Binary file (.${esc(ext)}). <a href="${url}" target="_blank" rel="noopener">Open / download ↗</a></div>`;
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

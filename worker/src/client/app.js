import './style.css';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const api = (path) => fetch(path).then((r) => r.json());

let TREE = {};      // { surface: { model: [ {path,file,name,order} ] } }
let FILES = [];     // flattened: { surface, model, path, file, name, order }
let activePath = null;

// ---------- tabs ----------
function showTab(name) {
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const s of document.querySelectorAll('.tab')) s.classList.toggle('hidden', s.id !== 'tab-' + name);
}
for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));

// ---------- init ----------
(async function init() {
  const data = await api('/api/tree');
  TREE = data.tree;
  FILES = [];
  for (const surface of Object.keys(TREE)) {
    for (const model of Object.keys(TREE[surface])) {
      for (const blk of TREE[surface][model]) FILES.push({ surface, model, ...blk });
    }
  }
  const when = data.generatedAt ? new Date(data.generatedAt).toLocaleString() : '';
  $('#meta').textContent = `${data.count} blocks · built ${when}`;
  renderTree();
  fillPickers();
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

// ---------- disclaimer ----------
const disclaimer = $('#disclaimer');
$('#disclaimer-open').addEventListener('click', () => disclaimer.showModal());
disclaimer.addEventListener('close', () => localStorage.setItem('disclaimerAck', '1'));
if (!localStorage.getItem('disclaimerAck')) disclaimer.showModal();

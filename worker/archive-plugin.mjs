// Vite plugins that expose repo content to the app.
//   import archive from 'virtual:archive'   // prompt blocks (code/ + web/ *.txt, minus web/skills/)
//   import skills  from 'virtual:skills'     // skill metadata + file manifests (web/skills/**)
// Skill *file contents* are not bundled into the Worker; they're served as static
// assets under /skills/<source>/<name>/<path> (emitted at build, proxied in dev),
// and the file explorer fetches them on demand. Re-run dev/build to pick up changes.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';

function walk(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(full));
    else if (ent.isFile()) out.push(full);
  }
  return out;
}

// ---- prompt-block archive (virtual:archive) ----
function scanArchive(repoRoot) {
  const files = [];
  for (const surface of ['code', 'web']) {
    let all;
    try {
      all = walk(join(repoRoot, surface));
    } catch {
      continue;
    }
    for (const full of all) {
      if (!full.endsWith('.txt')) continue;
      const rel = relative(repoRoot, full).split(sep).join('/');
      if (rel.startsWith('web/skills/')) continue; // skill bundles aren't prompt blocks
      const parts = rel.split('/');
      const filename = parts[parts.length - 1];
      const m = filename.match(/^(\d+)[_-]?(.*)\.txt$/i);
      files.push({
        path: rel,
        surface,
        model: parts[1],
        file: filename,
        order: m ? parseInt(m[1], 10) : 9999,
        name: (m ? m[2] : filename.replace(/\.txt$/i, '')) || filename,
        content: readFileSync(full, 'utf8'),
      });
    }
  }
  files.sort(
    (a, b) =>
      a.surface.localeCompare(b.surface) ||
      a.model.localeCompare(b.model) ||
      a.order - b.order ||
      a.file.localeCompare(b.file)
  );
  return { generatedAt: new Date().toISOString(), count: files.length, files };
}

// ---- skill bundles (virtual:skills) — metadata + manifest only, no file contents ----
function parseFrontmatter(md) {
  const fm = {};
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const mm = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!mm) continue;
      let v = mm[2].trim();
      if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1);
      fm[mm[1]] = v;
    }
  }
  return fm;
}

function scanSkills(repoRoot) {
  const base = join(repoRoot, 'web', 'skills');
  const skills = [];
  for (const source of ['public', 'examples']) {
    let entries;
    try {
      entries = readdirSync(join(base, source), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const skillDir = join(base, source, ent.name);
      let md;
      try {
        md = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
      } catch {
        continue; // a directory without SKILL.md isn't a skill
      }
      const fm = parseFrontmatter(md);
      const files = walk(skillDir)
        .map((f) => ({ path: relative(skillDir, f).split(sep).join('/'), size: statSync(f).size }))
        .sort((a, b) => a.path.localeCompare(b.path));
      skills.push({
        id: `${source}/${ent.name}`,
        source,
        name: fm.name || ent.name,
        description: fm.description || '',
        license: fm.license || '',
        files,
      });
    }
  }
  skills.sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
  return { generatedAt: new Date().toISOString(), count: skills.length, skills };
}

const MIME = {
  md: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8', js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8', html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8', csv: 'text/csv; charset=utf-8', svg: 'image/svg+xml', py: 'text/x-python; charset=utf-8',
  sh: 'text/x-sh; charset=utf-8', xml: 'application/xml; charset=utf-8', xsd: 'application/xml; charset=utf-8',
  yaml: 'text/yaml; charset=utf-8', yml: 'text/yaml; charset=utf-8', ttf: 'font/ttf', otf: 'font/otf',
  woff: 'font/woff', woff2: 'font/woff2', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', gz: 'application/gzip',
};
function mimeOf(p) {
  return MIME[p.slice(p.lastIndexOf('.') + 1).toLowerCase()] || 'application/octet-stream';
}

function virtualModule(name, id, scan) {
  const resolved = '\0' + id;
  const repoRoot = resolve(import.meta.dirname, '..');
  return {
    name,
    resolveId(i) {
      if (i === id) return resolved;
    },
    load(i) {
      if (i !== resolved) return;
      const data = scan(repoRoot);
      this.info?.(`${name}: bundled ${data.count} items`);
      return `export default ${JSON.stringify(data)};`;
    },
  };
}

export function archive() {
  return virtualModule('archive-data', 'virtual:archive', scanArchive);
}

export function skills() {
  const repoRoot = resolve(import.meta.dirname, '..');
  const skillsRoot = join(repoRoot, 'web', 'skills');
  const base = virtualModule('skills-data', 'virtual:skills', scanSkills);
  return {
    ...base,
    // Dev: serve raw skill files at /skills/<rel> straight from disk.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url || '';
        if (!url.startsWith('/skills/')) return next();
        const rel = decodeURIComponent(url.slice('/skills/'.length).split('?')[0]);
        const fp = join(skillsRoot, rel);
        if (!resolve(fp).startsWith(resolve(skillsRoot))) {
          res.statusCode = 403;
          return res.end('forbidden');
        }
        try {
          const body = readFileSync(fp);
          res.setHeader('content-type', mimeOf(fp));
          res.end(body);
        } catch {
          res.statusCode = 404;
          res.end('not found');
        }
      });
    },
    // Build: emit raw skill files as static assets under skills/ (client output only).
    generateBundle() {
      if (this.environment?.name && this.environment.name !== 'client') return;
      for (const f of walk(skillsRoot)) {
        if (f.endsWith('.skill')) continue; // skip the packaged zips
        this.emitFile({ type: 'asset', fileName: 'skills/' + relative(skillsRoot, f).split(sep).join('/'), source: readFileSync(f) });
      }
    },
  };
}

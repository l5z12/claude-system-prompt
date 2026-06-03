// Vite plugin: scans the archive (../code, ../web) and exposes it to the Worker
// as `import archive from 'virtual:archive'`. No generated file on disk — the
// JSON is inlined into the Worker bundle at build time. Re-run dev/build to pick
// up archive changes.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';

const VIRTUAL_ID = 'virtual:archive';
const RESOLVED_ID = '\0' + VIRTUAL_ID;

function walk(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(full));
    else if (ent.isFile() && ent.name.endsWith('.txt')) out.push(full);
  }
  return out;
}

function scanArchive(repoRoot) {
  const files = [];
  for (const surface of ['code', 'web']) {
    let txts;
    try {
      txts = walk(join(repoRoot, surface));
    } catch {
      continue;
    }
    for (const full of txts) {
      const rel = relative(repoRoot, full).split(sep).join('/');
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

export function archive() {
  const repoRoot = resolve(import.meta.dirname, '..');
  return {
    name: 'archive-data',
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
    },
    load(id) {
      if (id !== RESOLVED_ID) return;
      const data = scanArchive(repoRoot);
      this.info?.(`archive: bundled ${data.count} blocks`);
      return `export default ${JSON.stringify(data)};`;
    },
  };
}

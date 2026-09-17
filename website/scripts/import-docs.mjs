// Import the canonical markdown under /docs into the Starlight content tree.
//
// The repository's /docs directory stays the single source of truth for the
// four per-language guides and the TxPlan reference. This script copies those
// files into src/content/docs/, adding Starlight frontmatter (title from the
// H1) and rewriting relative .md links to site routes. The copies are build
// artifacts (gitignored) — regenerate with `npm run import-docs`, which also
// runs automatically before `dev` and `build`.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const DOCS_SRC = path.join(REPO_ROOT, 'docs');
const CONTENT_OUT = path.resolve(__dirname, '../src/content/docs');

const GITHUB_BLOB = 'https://github.com/bloxbean/mesmo/blob/develop';

// source (repo-relative) → destination (content-relative). Directory slugs on
// the site: docs/golang → /go/, README.md → the section index.
const FILES = [];
const LANGS = [
  ['js', 'js'],
  ['golang', 'go'],
  ['rust', 'rust'],
  ['python', 'python'],
];
for (const [srcDir, outDir] of LANGS) {
  FILES.push([`docs/${srcDir}/README.md`, `${outDir}/index.md`]);
  for (const page of ['api', 'transactions', 'providers', 'troubleshooting']) {
    FILES.push([`docs/${srcDir}/${page}.md`, `${outDir}/${page}.md`]);
  }
}
FILES.push(['docs/quicktx.md', 'reference/txplan.md']);

// repo-relative path → site route, used to rewrite inter-doc links.
const ROUTES = new Map();
for (const [src, out] of FILES) {
  const route = '/' + out.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '/');
  ROUTES.set(src, route.endsWith('/') ? route : route + '/');
}
ROUTES.set('docs/README.md', '/overview/');
ROUTES.set('README.md', GITHUB_BLOB + '/README.md');

function rewriteLink(target, srcRepoPath) {
  const [file, anchor = ''] = target.split('#');
  if (!file) return null; // pure #anchor — leave untouched
  // Resolve the relative target against the source file's directory.
  const resolved = path
    .normalize(path.join(path.dirname(srcRepoPath), file))
    .replaceAll('\\', '/');
  const route = ROUTES.get(resolved);
  if (route && route.startsWith('/')) {
    // Emit a link relative to the current page's route so it works under any
    // deployment base path (GitHub Pages project sites have one).
    const srcRoute = ROUTES.get(srcRepoPath) ?? '/';
    let rel = path.posix.relative(srcRoute, route);
    rel = rel === '' ? './' : rel + '/';
    return rel + (anchor ? `#${anchor}` : '');
  }
  if (route) return route + (anchor ? `#${anchor}` : ''); // absolute URL (GitHub)
  // Anything not on the site (ADRs, RELEASING.md, source files…) → GitHub.
  if (!resolved.startsWith('..')) {
    return `${GITHUB_BLOB}/${resolved}` + (anchor ? `#${anchor}` : '');
  }
  return null;
}

function transform(markdown, srcRepoPath) {
  // Title = first H1; strip it (Starlight renders the frontmatter title).
  const h1 = markdown.match(/^#\s+(.+?)\s*$/m);
  const title = (h1 ? h1[1] : path.basename(srcRepoPath, '.md'))
    .replaceAll(/[*_`]/g, '')
    .trim();
  let body = h1 ? markdown.replace(h1[0], '').replace(/^\s+/, '') : markdown;

  // Rewrite markdown links pointing at .md files (skip absolute URLs).
  body = body.replaceAll(
    /\]\((?!https?:\/\/)([^)\s]+?\.md(?:#[^)\s]*)?)\)/g,
    (match, target) => {
      const rewritten = rewriteLink(target, srcRepoPath);
      return rewritten ? `](${rewritten})` : match;
    },
  );

  const escapedTitle = title.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return `---\ntitle: "${escapedTitle}"\n---\n\n${body}`;
}

async function main() {
  let count = 0;
  for (const [src, out] of FILES) {
    const srcPath = path.join(REPO_ROOT, src);
    const outPath = path.join(CONTENT_OUT, out);
    const markdown = await fs.readFile(srcPath, 'utf8');
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, transform(markdown, src));
    count++;
  }
  console.log(`[import-docs] imported ${count} pages from ${path.relative(process.cwd(), DOCS_SRC)}`);
}

main().catch((err) => {
  console.error('[import-docs] failed:', err);
  process.exit(1);
});

// Generate llms.txt and llms-full.txt for AI agent ingestion.
//
// llms.txt      — curated index following the llmstxt.org convention
// llms-full.txt — single-file concatenation of all docs for direct ingestion
//
// Both are written into the Astro build output so they ship alongside the
// static site. Raw markdown copies of the AI pages are published too, so
// `curl .../ai/starter-pack.md` works.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS_ROOT = path.resolve(__dirname, '..');
const CONTENT_ROOT = path.join(DOCS_ROOT, 'src/content/docs');

const SITE = 'https://pages.bloxbean.com/mesmo';

// Curated section order — mirrors the Astro sidebar in astro.config.mjs.
// Missing files are skipped gracefully so a rename does not fail the build.
const SECTIONS = [
  { title: 'AI', files: ['ai/index.md', 'ai/starter-pack.md'] },
  { title: 'Overview', files: ['overview.md', 'getting-started.md'] },
  {
    title: 'JavaScript (Bun)',
    files: ['js/index.md', 'js/api.md', 'js/transactions.md', 'js/providers.md', 'js/troubleshooting.md'],
  },
  {
    title: 'Go',
    files: ['go/index.md', 'go/api.md', 'go/transactions.md', 'go/providers.md', 'go/troubleshooting.md'],
  },
  {
    title: 'Rust',
    files: ['rust/index.md', 'rust/api.md', 'rust/transactions.md', 'rust/providers.md', 'rust/troubleshooting.md'],
  },
  {
    title: 'Python',
    files: ['python/index.md', 'python/api.md', 'python/transactions.md', 'python/providers.md', 'python/troubleshooting.md'],
  },
  {
    title: 'Reference',
    files: [
      'reference/txplan.md',
      'reference/platforms.md',
      'reference/limitations.md',
      'reference/architecture.md',
    ],
  },
];

function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { meta: {}, body: raw };
  const meta = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*"?(.*?)"?\s*$/);
    if (kv) meta[kv[1]] = kv[2];
  }
  return { meta, body: raw.slice(match[0].length) };
}

function routeFor(file) {
  return SITE + '/' + file.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '/');
}

async function readDoc(file) {
  try {
    const raw = await fs.readFile(path.join(CONTENT_ROOT, file), 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    return { file, title: meta.title ?? file, description: meta.description ?? '', body: body.trim() };
  } catch {
    return null;
  }
}

export async function generateLlmsFiles({ outDir, logger }) {
  const sections = [];
  for (const section of SECTIONS) {
    const docs = (await Promise.all(section.files.map(readDoc))).filter(Boolean);
    if (docs.length) sections.push({ title: section.title, docs });
  }

  // llms.txt — curated index (llmstxt.org)
  let index = `# Mesmo

> Cardano Client Lib (CCL) compiled to a native shared library (libmesmo) with a C ABI,
> plus four first-class language wrappers — Python, Go, Rust, and JavaScript (Bun) —
> for fully offline Cardano key derivation, address handling, transaction building
> (TxPlan YAML), signing, Plutus data, and governance operations. No JVM at runtime.

Key entry points for AI agents:

- [AI Starter Pack](${SITE}/ai/starter-pack.md): everything an agent needs to use the bindings correctly
- [llms-full.txt](${SITE}/llms-full.txt): the full docsite as one markdown file
`;
  for (const { title, docs } of sections) {
    index += `\n## ${title}\n\n`;
    for (const doc of docs) {
      index += `- [${doc.title}](${routeFor(doc.file)})${doc.description ? `: ${doc.description}` : ''}\n`;
    }
  }

  // llms-full.txt — full concatenation
  let full = `# Mesmo — full documentation\n\n> Generated from the docsite. One file, all pages, for AI ingestion.\n`;
  for (const { title, docs } of sections) {
    for (const doc of docs) {
      full += `\n\n---\n\n# ${doc.title}\n\nSource: ${routeFor(doc.file)}\n\n${doc.body}\n`;
    }
  }

  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'llms.txt'), index);
  await fs.writeFile(path.join(outDir, 'llms-full.txt'), full);

  // Raw markdown copies of the AI pages.
  await fs.mkdir(path.join(outDir, 'ai'), { recursive: true });
  for (const file of ['ai/index.md', 'ai/starter-pack.md']) {
    const doc = await readDoc(file);
    if (doc) {
      const out = file === 'ai/index.md' ? 'ai/index.md' : file;
      await fs.writeFile(path.join(outDir, out), `# ${doc.title}\n\n${doc.body}\n`);
    }
  }

  logger?.info?.('[llms-txt] wrote llms.txt, llms-full.txt, ai/*.md');
}

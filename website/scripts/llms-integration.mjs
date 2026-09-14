// Astro integration exposing the AI ingestion artifacts:
//   /llms.txt              curated index (llmstxt.org convention)
//   /llms-full.txt         full docsite concatenated for ingestion
//   /ai/starter-pack.md    raw markdown copy of the AI Starter Pack
//   /ai/index.md           raw markdown copy of the /ai/ landing page
//
// - `astro build`: writes the files into the build output (`dist/`) so they
//   ship alongside the static site.
// - `astro dev`: a Vite middleware generates them on demand, so
//   http://localhost:4321/<base>/llms.txt works without restarting.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { generateLlmsFiles } from './generate-llms-txt.mjs';

const SERVED_FILES = ['/llms.txt', '/llms-full.txt', '/ai/starter-pack.md', '/ai/index.md'];

export default function llmsIntegration() {
  let base = '/';
  return {
    name: 'ccl-llms-txt',
    hooks: {
      'astro:config:done': ({ config }) => {
        base = config.base ?? '/';
      },

      'astro:build:done': async ({ dir, logger }) => {
        const outDir = fileURLToPath(dir);
        try {
          await generateLlmsFiles({ outDir, logger });
        } catch (err) {
          logger.error(`[llms-txt] generation failed: ${err.stack || err.message}`);
          throw err;
        }
      },

      'astro:server:setup': async ({ server, logger }) => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccl-llms-'));
        const silent = { info: () => {}, error: (m) => logger.error(m) };
        const servedPaths = new Set(
          SERVED_FILES.map((p) => path.posix.join(base, p)),
        );

        server.middlewares.use(async (req, res, next) => {
          const reqUrl = (req.url || '').split('?')[0];
          if (!servedPaths.has(reqUrl)) return next();
          try {
            await generateLlmsFiles({ outDir: tmpDir, logger: silent });
            const rel = path.posix.relative(base, reqUrl);
            const content = await fs.readFile(path.join(tmpDir, rel));
            res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
            res.end(content);
          } catch (err) {
            logger.error(`[llms-txt] ${err.message}`);
            res.statusCode = 500;
            res.end('llms generation failed');
          }
        });
        logger.info(`[llms-txt] dev middleware ready (${SERVED_FILES.join(', ')})`);
      },
    },
  };
}

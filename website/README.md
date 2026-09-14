# Mesmo — docsite

The project website and user documentation, built with [Astro](https://astro.build) + [Starlight](https://starlight.astro.build) (mirroring the [JuLC](https://github.com/bloxbean/julc) docsite setup).

## Develop

```bash
cd website
npm install
npm run dev        # http://localhost:4321/mesmo/
npm run build      # → dist/
```

## Where content lives

- **Canonical user docs stay in [`/docs`](../docs)** (per-language guides + the TxPlan reference). `npm run import-docs` (run automatically by `dev`/`build`) copies them into `src/content/docs/` with Starlight frontmatter and rewritten links; those copies are gitignored build artifacts — **edit `/docs`, not the copies**.
- **Site-only pages** are authored here: `overview`, `getting-started`, `reference/platforms`, `reference/limitations`, `reference/architecture`, and the `ai/` section (AI landing page + Starter Pack).
- The landing page is `src/pages/index.astro`.

## AI artifacts

The `scripts/llms-integration.mjs` Astro integration publishes, at build time and in `astro dev`:

- `/llms.txt` — curated index ([llmstxt.org](https://llmstxt.org))
- `/llms-full.txt` — the whole docsite as one markdown file
- `/ai/starter-pack.md`, `/ai/index.md` — raw markdown for `curl`-ing into `CLAUDE.md` / Cursor rules

## Deployment

`.github/workflows/website-deploy.yml` builds and publishes `website/dist` to GitHub Pages on a `dv*` tag (or manual dispatch), matching JuLC's flow. The site currently assumes the GitHub Pages project path (`https://pages.bloxbean.com/mesmo`); when a custom domain is chosen, set it in `astro.config.mjs` (`SITE`, drop `BASE`), add a `public/CNAME`, and update the hard-coded URLs in the AI pages.

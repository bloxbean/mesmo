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

`.github/workflows/website-deploy.yml` builds and publishes `website/dist` to the `gh-pages` branch on a push to `main` that touches `website/` or `docs/` (or manual dispatch). The site is served from **https://getmesmo.dev**, so it lives at the domain root and `astro.config.mjs` sets no `base`.

`public/CNAME` is what holds the custom domain: the deploy replaces the whole `gh-pages` tree, so a CNAME written once by the Pages settings UI would be wiped on the next deploy. Keeping it in `public/` means every build ships it. Changing the domain means editing that file, `SITE` in `astro.config.mjs`, and the absolute URLs in `scripts/generate-llms-txt.mjs`, `src/content/docs/ai/index.md` and `src/pages/index.astro`.

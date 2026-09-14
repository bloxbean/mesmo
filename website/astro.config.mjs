// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import tailwindcss from '@tailwindcss/vite';
import llmsIntegration from './scripts/llms-integration.mjs';

// Current host: the org-wide GitHub Pages domain (bloxbean.github.io redirects here).
// TODO: switch to the final Mesmo docs domain when it exists.
const SITE = 'https://pages.bloxbean.com';
const BASE = process.env.DOCS_BASE ?? '/mesmo';

export default defineConfig({
  site: SITE,
  base: BASE,
  integrations: [
    starlight({
      title: 'Mesmo',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/bloxbean/mesmo' },
      ],
      editLink: {
        baseUrl: 'https://github.com/bloxbean/mesmo/edit/develop/website/',
      },
      customCss: ['./src/styles/starlight.css'],
      sidebar: [
        { label: 'Overview', slug: 'overview' },
        { label: 'Getting Started', slug: 'getting-started' },
        {
          label: 'AI Agents',
          items: [
            { label: 'Using CCL Bindings with AI', slug: 'ai' },
            { label: 'AI Starter Pack', slug: 'ai/starter-pack' },
          ],
        },
        {
          label: 'JavaScript (Bun)',
          items: [
            { label: 'Introduction', slug: 'js' },
            { label: 'API Reference', slug: 'js/api' },
            { label: 'Building Transactions', slug: 'js/transactions' },
            { label: 'Providers & Evaluators', slug: 'js/providers' },
            { label: 'Troubleshooting', slug: 'js/troubleshooting' },
          ],
        },
        {
          label: 'Go',
          items: [
            { label: 'Introduction', slug: 'go' },
            { label: 'API Reference', slug: 'go/api' },
            { label: 'Building Transactions', slug: 'go/transactions' },
            { label: 'Providers & Evaluators', slug: 'go/providers' },
            { label: 'Troubleshooting', slug: 'go/troubleshooting' },
          ],
        },
        {
          label: 'Rust',
          items: [
            { label: 'Introduction', slug: 'rust' },
            { label: 'API Reference', slug: 'rust/api' },
            { label: 'Building Transactions', slug: 'rust/transactions' },
            { label: 'Providers & Evaluators', slug: 'rust/providers' },
            { label: 'Troubleshooting', slug: 'rust/troubleshooting' },
          ],
        },
        {
          label: 'Python',
          items: [
            { label: 'Introduction', slug: 'python' },
            { label: 'API Reference', slug: 'python/api' },
            { label: 'Building Transactions', slug: 'python/transactions' },
            { label: 'Providers & Evaluators', slug: 'python/providers' },
            { label: 'Troubleshooting', slug: 'python/troubleshooting' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'TxPlan (YAML) Format', slug: 'reference/txplan' },
            { label: 'Platforms & Packages', slug: 'reference/platforms' },
            { label: 'Caveats & Limitations', slug: 'reference/limitations' },
            { label: 'Architecture (ADRs)', slug: 'reference/architecture' },
          ],
        },
      ],
    }),
    llmsIntegration(),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});

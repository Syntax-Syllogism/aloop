import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLinksValidator from 'starlight-links-validator';
import {
  remarkRelativeMdLinks,
  starlightPreset,
} from '@syntax-syllogism/docs-theme';

const BASE = '/aloop/docs';

export default defineConfig({
  site: 'https://syntax-syllogism.com',
  base: BASE,
  outDir: './dist',
  trailingSlash: 'always',
  markdown: {
    remarkPlugins: [[remarkRelativeMdLinks, { base: BASE, docsRoot: '../docs' }]],
  },
  integrations: [
    starlight(
      starlightPreset({
        title: 'aloop',
        base: BASE,
        toolSlug: 'aloop',
        publicRepo: 'Syntax-Syllogism/aloop',
        accent: 'green',
      }),
    ),
    starlightLinksValidator(),
  ],
});

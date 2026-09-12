import { defineCollection } from 'astro:content';
import { docsSchema } from '@astrojs/starlight/schema';
import { docsGlobLoader } from '@syntax-syllogism/docs-theme';

export const collections = {
  docs: defineCollection({
    loader: docsGlobLoader({ base: '../docs' }),
    schema: docsSchema(),
  }),
};

import { defineConfig } from 'astro/config';
import { loadSnapshot } from './src/snapshot';

const snapshot = loadSnapshot();

export default defineConfig({
  site: snapshot.siteUrl,
  outDir: process.env.PUSHPOST_OUT_DIR || './dist',
  trailingSlash: 'always',
});

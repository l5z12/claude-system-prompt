import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { archive, skills } from './archive-plugin.mjs';

export default defineConfig({
  plugins: [archive(), skills(), cloudflare()],
});

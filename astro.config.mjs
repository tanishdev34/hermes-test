// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'static',
  server: { port: 4321, host: '0.0.0.0' },
  vite: {
    server: { host: '0.0.0.0' }
  }
});

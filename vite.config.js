import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue2';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // The rendering worker is created with `type: 'module'`, so it must be
  // bundled as one. The default here is IIFE, which cannot code-split — and the
  // worker splits, because it loads the GeoTIFF decoder only when a sheet
  // actually uses LiDAR rather than on every page load.
  worker: {
    format: 'es',
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});

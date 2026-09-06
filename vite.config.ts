import { defineConfig } from 'vite';
export default defineConfig({
  base: './',
  server: { host: '0.0.0.0', port: 4173, strictPort: true, allowedHosts: ['terminal.local'] },
  build: {
    target: 'es2022', sourcemap: true, copyPublicDir: false,
    rollupOptions: {output:{manualChunks:{three:['three'],physics:['@dimforge/rapier3d-compat']}}}
  }
});

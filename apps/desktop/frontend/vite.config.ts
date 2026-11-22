import { defineConfig } from 'vite';
export default defineConfig({
  build: {
    target: 'safari15',
    rollupOptions: { external: ['/wails/runtime.js'] },
  },
});

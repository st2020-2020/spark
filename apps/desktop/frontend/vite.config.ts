import { defineConfig } from 'vite';
export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom'] },
  build: {
    target: 'safari15',
    rollupOptions: { external: ['/wails/runtime.js'] },
  },
});

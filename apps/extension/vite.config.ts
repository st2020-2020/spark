import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const DEFAULT_SPARK_ORIGIN = 'https://spark.stwqy.cloud';

function resolveTargetOrigin(): { origin: string; hostPattern: string; outDir: string } {
  const raw = (process.env.SPARK_EXTENSION_ORIGIN ?? DEFAULT_SPARK_ORIGIN).trim();
  const outDir = (process.env.SPARK_EXTENSION_OUT_DIR ?? 'dist').trim() || 'dist';
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid SPARK_EXTENSION_ORIGIN: ${raw}`);
  }
  const isLoopback =
    parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
    throw new Error(`SPARK_EXTENSION_ORIGIN must use https:// (or http:// only on loopback): ${raw}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`SPARK_EXTENSION_ORIGIN must not contain credentials: ${raw}`);
  }
  if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw new Error(`SPARK_EXTENSION_ORIGIN must be a bare origin without path/query/hash: ${raw}`);
  }
  // Chromium/Edge MV3 host_permissions match patterns disallow explicit ports.
  const hostPattern = `${parsed.protocol}//${parsed.hostname}/*`;
  return { origin: parsed.origin, hostPattern, outDir };
}

function syncExtensionManifestPlugin(hostPattern: string, outDir: string): Plugin {
  return {
    name: 'spark-sync-extension-manifest',
    closeBundle() {
      const distManifestPath = path.resolve(process.cwd(), outDir, 'manifest.json');
      if (!fs.existsSync(distManifestPath)) return;
      const manifest = JSON.parse(fs.readFileSync(distManifestPath, 'utf8')) as Record<string, unknown>;
      manifest.host_permissions = [hostPattern];
      delete manifest.optional_host_permissions;
      fs.writeFileSync(distManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    },
  };
}

const target = resolveTargetOrigin();

export default defineConfig({
  define: {
    __SPARK_EXTENSION_ORIGIN__: JSON.stringify(target.origin),
  },
  plugins: [syncExtensionManifestPlugin(target.hostPattern, target.outDir)],
  build: {
    outDir: target.outDir,
    emptyOutDir: true,
    target: 'es2022',
    minify: false,
    rollupOptions: {
      input: {
        popup: new URL('./popup.html', import.meta.url).pathname,
        background: new URL('./src/background/serviceWorker.ts', import.meta.url).pathname,
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'background' ? 'background.js' : 'assets/[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});

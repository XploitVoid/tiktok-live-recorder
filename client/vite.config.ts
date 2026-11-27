import path from 'path'
import { defineConfig, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
const apiTarget = `http://127.0.0.1:${process.env.PORT || '3000'}`;
const isLoopbackOrigin = (raw: string | undefined) =>
  typeof raw === 'string' && /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(raw);
const makeProxyConfig = (): ProxyOptions => ({
  target: apiTarget,
  changeOrigin: true,
  configure: (proxy) => {
    proxy.on('proxyReq', (proxyReq, req) => {
      const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
      const referer = Array.isArray(req.headers.referer) ? req.headers.referer[0] : req.headers.referer;
      if (isLoopbackOrigin(origin)) proxyReq.setHeader('origin', apiTarget);
      if (isLoopbackOrigin(referer)) proxyReq.setHeader('referer', `${apiTarget}/`);
    });
  },
});

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api': makeProxyConfig(),
      '/files': makeProxyConfig(),
    },
  },
  build: {
    outDir: 'dist',
    // Stable vendor chunks — when app code changes, browsers keep cached
    // copies of react / router / icons rather than re-downloading 200KB+
    // every deploy.
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('react-router')) return 'router'
          if (id.includes('react-dom') || /[\\/]react[\\/]/.test(id)) return 'react'
          if (id.includes('lucide-react')) return 'icons'
          if (id.includes('@base-ui') || id.includes('class-variance-authority') || id.includes('clsx') || id.includes('tailwind-merge')) {
            return 'ui'
          }
          if (id.includes('sonner')) return 'sonner'
          return 'vendor'
        },
      },
    },
    // Slightly larger threshold — large vendor chunks are expected and the
    // warning is noise once we're intentionally splitting.
    chunkSizeWarningLimit: 800,
  },
})

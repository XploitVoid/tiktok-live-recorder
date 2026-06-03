import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/files': 'http://localhost:3000',
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

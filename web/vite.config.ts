import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:7437',
      '/health': 'http://127.0.0.1:7437',
    },
  },
  build: {
    outDir: resolve(directory, '../src/oplogs/static'),
    emptyOutDir: true,
    sourcemap: true,
  },
})

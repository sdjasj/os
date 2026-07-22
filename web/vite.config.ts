import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const workspaceRoot = fileURLToPath(new URL('..', import.meta.url))

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    fs: {
      allow: [workspaceRoot],
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
  },
})

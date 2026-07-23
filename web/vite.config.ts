import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

const workspaceRoot = fileURLToPath(new URL('..', import.meta.url))
const webRoot = fileURLToPath(new URL('.', import.meta.url))

function normalizeBasePath(value: string | undefined) {
  const path = value?.trim() || '/os/'
  if (path === '/') return '/'

  return `/${path.replace(/^\/+|\/+$/g, '')}/`
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, webRoot, '')

  return {
    base: normalizeBasePath(env.VITE_BASE_PATH),
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
  }
})

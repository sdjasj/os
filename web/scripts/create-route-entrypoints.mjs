import { access, copyFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const projectSlugs = ['os', 'cubesandbox', 'e2b', 'minimind', 'ray', 'strix', 'arvo', 'mini-swe-agent', 'openhands', 'codex', 'openclaw', 'pwn-college']
const webRoot = fileURLToPath(new URL('..', import.meta.url))
const distRoot = path.join(webRoot, 'dist')
const rootEntrypoint = path.join(distRoot, 'index.html')

await access(rootEntrypoint)

await Promise.all(
  projectSlugs.map(async (slug) => {
    const routeDirectory = path.join(distRoot, 'projects', slug)
    await mkdir(routeDirectory, { recursive: true })
    await copyFile(rootEntrypoint, path.join(routeDirectory, 'index.html'))
  }),
)

await writeFile(path.join(distRoot, '.nojekyll'), '')

console.log(`Created GitHub Pages entrypoints for: ${projectSlugs.join(', ')}`)

import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'

// Safe{Wallet} fetches manifest.json cross-origin and loads the app in an iframe,
// so the dev server must answer with permissive CORS headers.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET',
  'Access-Control-Allow-Headers': 'X-Requested-With, content-type, Authorization',
}

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string
}

/** Commit being built: CI-provided SHA if any (Cloudflare, GitHub Actions), else the local checkout. */
function commitSha(): string {
  const fromCi = process.env.WORKERS_CI_COMMIT_SHA ?? process.env.GITHUB_SHA
  if (fromCi) return fromCi
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return ''
  }
}

export default defineConfig({
  plugins: [react()],
  base: './',
  // Build metadata shown in the footer (see src/env.d.ts).
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __COMMIT_SHA__: JSON.stringify(commitSha()),
  },
  // Safe{Wallet} needs a public HTTPS URL; allow Cloudflare tunnel hostnames (quick or named).
  server: { port: 5173, headers: corsHeaders, allowedHosts: ['.trycloudflare.com'] },
  preview: { port: 5173, headers: corsHeaders, allowedHosts: ['.trycloudflare.com'] },
})

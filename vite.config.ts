import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Safe{Wallet} fetches manifest.json cross-origin and loads the app in an iframe,
// so the dev server must answer with permissive CORS headers.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET',
  'Access-Control-Allow-Headers': 'X-Requested-With, content-type, Authorization',
}

export default defineConfig({
  plugins: [react()],
  base: './',
  // Safe{Wallet} needs a public HTTPS URL; allow Cloudflare tunnel hostnames (quick or named).
  server: { port: 5173, headers: corsHeaders, allowedHosts: ['.trycloudflare.com'] },
  preview: { port: 5173, headers: corsHeaders, allowedHosts: ['.trycloudflare.com'] },
})

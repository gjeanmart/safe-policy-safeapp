import { defineConfig } from 'vite'

/**
 * Bundles the agent CLI (agent/src/main.ts) into one Node ESM file, dependencies included: a single
 * artifact to review and run, with no runtime resolution from node_modules.
 */
export default defineConfig({
  ssr: { noExternal: true },
  publicDir: false,
  build: {
    ssr: 'agent/src/main.ts',
    outDir: 'agent/dist',
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    rolldownOptions: {
      output: { entryFileNames: 'safe-role.mjs', banner: '#!/usr/bin/env node', codeSplitting: false },
    },
  },
})

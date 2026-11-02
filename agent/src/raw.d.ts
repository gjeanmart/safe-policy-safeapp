/** Vite `?raw` imports: the file content as a string (used to bundle the guide, see guide.ts). */
declare module '*.md?raw' {
  const content: string
  export default content
}

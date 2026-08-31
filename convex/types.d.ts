/**
 * Minimal ambient declaration for Vite's `import.meta.glob`, used by
 * `convex/test.setup.ts` to build the module map convex-test needs.
 *
 * Declared here rather than via `/// <reference types="vite/client" />` because
 * pnpm does not hoist `vite` (it is a transitive dep of vitest), so the
 * reference would not resolve under `tsc`.
 */
interface ImportMeta {
  glob(pattern: string): Record<string, () => Promise<unknown>>
}

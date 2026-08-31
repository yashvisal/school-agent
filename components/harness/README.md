# `components/harness` — forked Beautiful UI primitives

Vendored fork of **Beautiful UI** by Shane Levine.

- Upstream: <https://github.com/slev12397/beautiful-ui> (demo: <https://www.beautifului.dev/harness>)
- License: **MIT** — copyright (c) Shane Levine. The upstream `LICENSE` applies to everything in
  this directory and to the design tokens / component CSS merged into `app/globals.css`.
- Forked at commit `3ea4c18114de3d4bc9b63b8e3ea6f533b1a562bd`
  ("Republish: registry, headless primitives, and issue fixes #2–#9 (#11)").

`components/harness/atoms/*` and `components/harness/primitives/*` are upstream
`components/atoms/*` and `components/primitives/*` with `@/components/{atoms,primitives}/…`
imports rewritten to `@/components/harness/…`.

The product shell that consumes them lives in `components/shell/`, the product panels in
`components/panels/`. Those are ours — edit them freely. Files in *this* directory should stay
close to upstream so we can re-pull fixes; deviations are listed below and marked in-file.

## Dependencies stripped (none of these may be added to `package.json`)

| Upstream dep                         | What we did                                                                                                                             |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `posthog-js`                         | Not present in `atoms/`/`primitives/` upstream (only in `components/site/`, which we didn't copy). Nothing to remove.                     |
| `@web-kits/audio` / `InteractionSounds` | `components/site/` only — not copied.                                                                                                  |
| `glimm`                              | Removed the rainbow shader sweep + `<canvas>` from `PromptBar`. Picking the flagship model is now a plain state change.                   |
| `liveline`                           | `InsightCards.tsx` **not copied** (it is the only consumer; it is a chart primitive we have no product use for yet).                      |
| `shadow-plugin`                      | The `--shadow-2xs … --shadow-2xl` scale is inlined as plain custom properties at the top of `app/globals.css` instead of `@import`-ed.    |
| `@central-icons-react/*`             | `SidebarNav` icons swapped 1:1 for `lucide-react` at the same size/stroke.                                                                |
| `iconoir-react`                      | `SelectionActions` icons swapped 1:1 for `lucide-react` at the same size/stroke.                                                          |

`dialkit` and `motion` are kept — both are already in `package.json`.

## Other deviations from upstream

- **`TaskRows`** gained a `"todo"` status and an optional `pill` string. Upstream has `done`,
  `running` and an animation-driven `sequence`; our plan rows are mostly not-yet-started, and
  upstream had no static state for that.
- **Lint fixes** for this repo's stricter `react-hooks` rules (behaviour preserved):
  `StreamText` (ref writes moved out of render, reveal reset moved to a render-time state
  adjustment), `ApprovalCard` / `PromptBar` / `RecordsTable` (synchronous `setState` inside
  effects deferred by one frame or moved to render-time state adjustment), `Flowchart` (the
  node ref map replaced with `data-node-id` DOM queries; the dragging id mirrored into state).
- `StreamingText` still uses `<img>` for remote favicons (three `@next/next/no-img-element`
  warnings). `next/image` would need `images.remotePatterns` in `next.config.ts`, which the Face
  workstream does not own.

## CSS

The token set (`:root` + `.dark`), the `@theme inline` mapping, the base rules, the
`primitive-*` spacing utilities, the shared keyframes, and the component-specific blocks for
`SidebarNav`, `RecordsTable`, `FilterTable`, `StreamText` and `StreamingText`/`ContextCards` are
merged into `app/globals.css`. The `InsightCards` chart-tooltip block was dropped with the
component. The upstream `body` diagonal stripe was replaced with a flat `var(--canvas)` — the app
shell covers the whole viewport, so the texture never showed.

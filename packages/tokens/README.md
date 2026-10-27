# @stackd/tokens

One token set for six looks (Modern, Minimal, Retro 80s, Pastel, Anime, Illustrative) × two modes. `tokens.json` is the source; `src/build.ts` writes `dist/tokens.css` (CSS custom properties) and `dist/tokens.ts` (precomputed data). Components read the variables only; there are no per-look component forks.

```bash
pnpm build        # dist/tokens.css + dist/tokens.ts
pnpm test         # shape, variable coverage, CSS output
pnpm typecheck
pnpm -w contrast  # WCAG AA over every look × mode (also a CI guard)
```

## How the CSS works

- `:root` carries Modern light so a page is never unstyled.
- `[data-look="…"][data-mode="light|dark"]` sets an explicit theme.
- Inside `@media (prefers-color-scheme: dark)`, `[data-look="…"]:not([data-mode="light"])` makes "system" (or a missing `data-mode`) follow the OS.
- Variables: `--c-*` colors (`bg card ink sub line a1 a2 a3 on-accent success danger warning offline-bg offline-text pending-bg pending-text`), `--radius-card`, `--border-card`, `--shadow-card`, `--radius-toggle`, `--font-display|body|hero|data`, `--numeric-data`.
- The PWA offers all six looks (`availability.pwa`); the native apps offer Modern, Pastel and Anime (`availability.native_ios_android`, `NATIVE_LOOKS`). Owner decision, October 12, 2026.

## Deviations from the design handoff

`docs/design-handoff/tokens.json` is the original export. This copy differs only where the contrast guard required it:

| Token | Handoff | Here | Why |
|---|---|---|---|
| semantic warning, light | `#A85A00` | `#A55800` | 4.46:1 on Pastel light bg `#EEF0F4`; now 4.61:1. The spec lists semantic colors as "proposed, verify contrast". |
- Minimal, Retro 80s and Illustrative (October 12, 2026) are not in the design handoff: designed here from the same token schema, every pair checked by `pnpm contrast`. Borders may reference `line` as well as `ink`.

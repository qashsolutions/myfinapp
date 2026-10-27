# @stackd/ui

Shared React components for every screen. One implementation each, styled only through the custom properties that `@stackd/tokens` emits, so Modern, Pastel and Anime render from the same code (docs/spec.md "Theme rules": same layout, same wording, locked semantic colours, 44 px touch targets).

| Component | Notes |
|---|---|
| `Button` / `buttonClass()` | `primary`, `secondary`, `ghost`, `danger`; `sm`; `block`. `type="button"` by default. `buttonClass` styles a router link as a button. |
| `Card` | `tone="accent"` for the hero card; `decor` marks decoration that Simple layout hides; `as` picks the element. Helper classes: `sk-card__eyebrow`, `sk-card__title`, `sk-card__hero`. |
| `List` / `ListRow` | `<ul>` + `<li>`. A row becomes a `<button>` with `onClick` or an `<a>` with `href`; otherwise plain. `value`, `sublabel`, `leading`, `valueTone`. |
| `Toggle` | A native checkbox with `role="switch"`, labelled by its text, described by `description`; track radius comes from `--radius-toggle`. |
| `ProgressBar` | `role="progressbar"` with `aria-valuetext` (the required text equivalent); turns `success` at 100 %. |
| `Chip` | Pill label with `neutral`, `accent`, `success`, `warning`, `danger`, `pending` tones. |

Styles live in `src/ui.css` (`sk-` prefix) and are imported by `src/index.ts`, so consumers only import the components.

```bash
pnpm -C packages/ui test        # Vitest + jsdom + Testing Library
pnpm -C packages/ui typecheck
```

Later chunks add `Sheet`, `Toast`, `SentenceBuilder` and `TimePicker` (docs/spec.md Phase 1 tree).

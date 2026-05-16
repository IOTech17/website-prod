This is an EmDash site -- a CMS built on Astro with a full admin UI.

## Commands

```bash
npx emdash dev
npx emdash types
```

## Rules

- All content pages must be server-rendered. No `getStaticPaths()`.
- `entry.id` is the slug (for URLs). `entry.data.id` is the database ULID.
- Always call `if (Astro.cache?.enabled) Astro.cache.set(cacheHint)` on pages that query content.
- `getMenu()` can return null — always use `menu?.items.map()`.
- `publishedAt` is camelCase in `entry.data`, `published_at` in `orderBy` queries.

## Behavioral Guidelines

**Think Before Coding** — State assumptions. If unclear, ask.
**Simplicity First** — Minimum code. No speculative features.
**Surgical Changes** — Touch only what you must.
**Goal-Driven Execution** — Define verifiable success criteria before starting.

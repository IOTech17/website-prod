This is an EmDash site -- a CMS built on Astro with a full admin UI.

## Commands

```bash
npx emdash dev        # Start dev server (runs migrations, seeds, generates types)
npx emdash types      # Regenerate TypeScript types from schema
```

The admin UI is at `http://localhost:4321/_emdash/admin`.

## Key Files

| File                     | Purpose                                                         |
| ------------------------ | --------------------------------------------------------------- |
| `astro.config.mjs`       | Astro config with `emdash()` integration, database, and storage |
| `src/live.config.ts`     | EmDash loader registration (boilerplate — don't modify)         |
| `seed/seed.json`         | Schema definition + demo content                                |
| `emdash-env.d.ts`        | Generated types for collections                                 |
| `src/layouts/Base.astro` | Base layout with EmDash wiring                                  |
| `src/pages/`             | Astro pages — all server-rendered                               |

## Rules

- All content pages must be server-rendered. No `getStaticPaths()`.
- `entry.id` is the slug (for URLs). `entry.data.id` is the database ULID.
- Always call `Astro.cache.set(cacheHint)` on pages that query content.
- `getMenu()` can return null — always use `menu?.items.map()`.
- `publishedAt` is camelCase in `entry.data`, `published_at` in `orderBy` queries.
- Wiki pages require the markdown-wiki plugin — see `astro.config.mjs`.

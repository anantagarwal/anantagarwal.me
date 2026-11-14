# AGENTS.md

Personal website and technical blog (`https://anantagarwal.me/`) built with Astro 7, Tailwind CSS v4, React 19, MDX, `astro-mermaid`, KaTeX, and Pagefind (based on AstroPaper).

## Commands

CI runs `pnpm` (Node 20); `package-lock.json` is also present for `npm`.

- **Dev server:** `npm run dev`
- **Lint:** `npm run lint` (`eslint .`)
- **Format check / fix:** `npm run format:check` / `npm run format`
- **Type-check & build:** `npm run build` (`astro check && astro build && pagefind --site dist && cp -r dist/pagefind public/`)
- **Preview production build:** `npm run preview`

## Code Style & Constraints

- **TypeScript:** Strict mode (`astro/tsconfigs/strict`). Use the `@/*` path alias for `./src/*`.
- **ESLint (`eslint.config.js`):** `"no-console": "error"` is enforced; do not leave `console.*` calls in source files.
- **Prettier (`.prettierrc.mjs`):** 2-space indentation, double quotes, semicolons, `arrowParens: "avoid"`, `trailingComma: "es5"`, `printWidth: 80`, with `prettier-plugin-astro` and `prettier-plugin-tailwindcss`.

## Content & Markdown Conventions

- **Blog posts:** Live in `src/data/blog/` and are validated by the Zod schema in `src/content.config.ts` (`title`, `pubDatetime`, and `description` are required).
- **Authoring workflows:** Follow `.agent/workflows/blog.md` for general posts and `.agent/workflows/howitworks.md` for the `how-it-works` deep-dive series.
- **Math (`remark-math` + `rehype-katex`):** Use multi-line `$$` blocks (with `$$` on its own line, surrounded by blank lines) for display math. Escape literal currency dollar signs (`\$100`).
- **Callouts:** GitHub-style alerts (`> [!NOTE]`, `> [!TIP]`, etc.) are not supported and render as literal text. Use bold blockquotes instead (e.g., `> **Note**: ...`).
- **Mermaid (`astro-mermaid`):** Uses `autoTheme: true` and `MERMAID_FONT` in `astro.config.ts`, with colors controlled in `src/styles/typography.css`. Do not use `%%{init: ...}%%` directives, `style`/`linkStyle`, or `fill:`/`stroke:`/`color:` in `classDef`; use only the semantic classes `control`, `data`, `ok`, and `bad`.

## Generated Paths (Do Not Edit Directly)

- `dist/`
- `.astro/`
- `public/pagefind/` (updated by `npm run build`)

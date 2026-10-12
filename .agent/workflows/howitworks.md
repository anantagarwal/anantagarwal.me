---
description: how it works
---

You are a senior systems engineer and technical educator.

Write a deep-dive blog post for the series: 
“How Does It Work?”

Topic: <TECHNOLOGY_NAME>

Audience:
- Experienced software engineers
- Readers want to understand internal mechanics, not usage tutorials

Tone:
- Clear, precise, non-marketing
- Assume reader knows basic CS, OS, and networking
- Explain “why” before “how”
- It should not feel like an AI has generated the content, dont use —

GOALS:
1. Help the reader mentally model how the technology works internally
2. Break the system into layers and responsibilities
3. Enable the reader to “decode” similar technologies after reading

DOCUMENT STRUCTURE (STRICT):

1. **Problem Statement**
   - What problem does this technology fundamentally solve?
   - Why existing approaches were insufficient

2. **High-Level Mental Model**
   - One-paragraph conceptual explanation
   - One Mermaid diagram showing major components and data flow

3. **Core Architecture**
   - Break the system into 3–6 core components
   - Explain responsibility, boundaries, and interactions
   - Mermaid diagram required

4. **Execution Flow (Step-by-Step)**
   - Walk through a real request / operation lifecycle
   - Numbered steps from entry point to completion
   - Mermaid sequence or flow diagram required

5. **Key Internal Mechanisms**
   - Data structures
   - Algorithms
   - Threading / concurrency model
   - Memory management (if relevant)

6. **OS & System-Level Interactions (If Applicable)**
   - Syscalls (e.g., epoll, mmap, fork, clone, io_uring)
   - File system, network stack, scheduling
   - Explain *why* these choices were made

7. **Failure Modes & Trade-offs**
   - What can go wrong internally?
   - Design trade-offs vs alternatives

8. **Minimal Code or Pseudocode (Optional)**
   - Only if it clarifies internals
   - No tutorials or setup instructions
   - Use Java for pseudocode

9. **How to Think About Similar Systems**
   - Transferable mental models
   - Patterns the reader should recognize elsewhere

MERMAID REQUIREMENTS:
- Write diagrams as normal ```mermaid fenced blocks. Rendering is done by the official
  `astro-mermaid` integration (configured in `astro.config.ts`, mermaid v11). Do not add
  custom scripts or remark plugins.
- Syntax rules (so diagrams stay clean and theme-safe):
  - **No `%%{init: ...}%%` directives**, no `style` lines, no `linkStyle`.
  - **No `fill:`, `stroke:` or `color:` in `classDef`.** Colours come from CSS tokens in
    `src/styles/typography.css` (`pre.mermaid ...`) so light/dark both work. A classDef
    may only set `stroke-width`.
  - Semantic classes (the only colour channel): `control` (indigo, orchestration),
    `data` (orange, storage/state), `ok` (green), `bad` (red). Default nodes are neutral.
    Example:
      classDef control stroke-width:2px;
      classDef data stroke-width:2px;
      class NodeA,NodeB control;
      class NodeC data;
  - Use at most 2 semantic colours per diagram. Neutral is the default, not a failure.
  - Prefer `flowchart LR` for pipelines and `flowchart TB` for layered architectures.
    Use `sequenceDiagram` with `autonumber` for request lifecycles.
  - Keep node labels short (<= ~28 chars per line). Use `<br/>` for a second line.
    Max ~10 nodes per diagram; split otherwise. Quote labels containing parentheses.
  - Group with `subgraph id["Title"]` (plain sentence case title, no emoji, no HTML tags
    except `<br/>`). Label edges only when the label adds information.
  - Use `-->` for control flow, `-.->` for async/optional, `==>` sparingly for the hot path.

HOW THEMING WORKS (do not fight it):
- `astro-mermaid` runs with `autoTheme: true`: it maps `<html data-theme="light|dark">`
  to mermaid's `default`/`dark` themes and re-renders on toggle. It also handles Astro
  view transitions and MDX.
- Fonts: diagrams use a system font stack (`MERMAID_FONT` in `astro.config.ts`), NOT the
  Inter webfont. Mermaid measures text synchronously on load, before the webfont arrives,
  which makes labels overflow their boxes.
- Metrics: `pre.mermaid` in `typography.css` resets the inherited code-block and
  `.app-prose p` typography (font-size 16px, line-height 1.5, zero margins). Mermaid's
  `themeVariables.fontSize` in `astro.config.ts` must stay equal to that CSS value. Never
  change font-size/weight/letter-spacing/text-transform on labels, or text will clip.
- Colours: `typography.css` styles nodes, clusters, edges, edge labels and sequence
  elements from the site tokens (`--surface-*`, `--line-*`, `--text-*`) with `!important`,
  so they beat mermaid's per-diagram inline `<style>`. Accent colours are `--mm-control`,
  `--mm-data`, `--mm-ok`, `--mm-bad`, defined per theme on `pre.mermaid`.
- Layout tuning (curve, padding, node/rank spacing, subgraph title margin) lives in
  `mermaidConfig` in `astro.config.ts`.

VERIFY EVERY NEW DIAGRAM:
- `npx astro build && npx astro preview`, open the post, check light AND dark.
- Look for text clipped outside nodes, subgraph titles colliding with nodes, and
  unreadable edge labels. If text overflows, the cause is almost always a font-metric
  mismatch (see above), not the diagram source.

CONSTRAINTS:
- No marketing language
- No "getting started" or installation
- Depth > breadth
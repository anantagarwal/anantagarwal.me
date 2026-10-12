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
- Use Mermaid syntax only
- **DO NOT include `%%{init: ...}%%` directives in diagrams.** Theming is handled at
  runtime by `mermaid.initialize()` reading CSS custom properties (`--mermaid-*`,
  `--foreground`, `--background`). Inline init blocks would bake in hardcoded
  light-mode colors that cannot be overridden in dark mode.
- Use blue for control / orchestration (control classDef)
- Use orange for data / storage components (data classDef)
- **DO NOT include `fill:` or `stroke:` in classDef declarations.** Mermaid bakes
  classDef fill/stroke values into its internal SVG `<style>` block, which overrides
  external CSS and breaks dark mode. Only `stroke-width` is allowed. Colors come from
  `themeVariables` (set in `PostDetails.astro` from CSS custom properties) and CSS
  selectors targeting `.node.control` and `.node.data` in `global.css`.
  Example:
  classDef control stroke-width:2px;
  classDef data stroke-width:2px;
  class NodeA,NodeB control;
  class NodeC data;

DARK MODE NOTES:
- The site uses `data-theme="dark"` on `<html>`. CSS custom properties in `global.css`
  define separate palettes for `:root` (light) and `html[data-theme="dark"]` (dark).
- `PostDetails.astro` initializes mermaid with `theme: "base"` and passes computed
  CSS variable values as `themeVariables`, so the SVG is rendered with the correct
  palette from the start.
- Additional CSS selectors in `global.css` under `.mermaid-container` override edge
  labels, subgraph backgrounds, sequence diagram actors/lifelines/activation boxes,
  arrowheads, and autonumber badges. This provides a safety net if mermaid's own
  theming misses an element.
- A `MutationObserver` watches `data-theme` changes and re-renders all diagrams with
  updated colors when the user toggles themes.

CONSTRAINTS:
- No marketing language
- No "getting started" or installation
- Depth > breadth
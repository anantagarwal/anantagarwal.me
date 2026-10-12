import { defineConfig, envField } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import sitemap from "@astrojs/sitemap";
import { unified } from "@astrojs/markdown-remark";
import remarkToc from "remark-toc";
import remarkCollapse from "remark-collapse";
import {
  transformerNotationDiff,
  transformerNotationHighlight,
  transformerNotationWordHighlight,
} from "@shikijs/transformers";
import { transformerFileName } from "./src/utils/transformers/fileName";
import { SITE } from "./src/config";

import mdx from "@astrojs/mdx";

import react from "@astrojs/react";

import mermaid from "astro-mermaid";

// System font stack on purpose: mermaid measures text synchronously on load,
// before the Inter webfont arrives. A webfont here causes labels to overflow nodes.
const MERMAID_FONT =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

// https://astro.build/config
export default defineConfig({
  site: SITE.website,
  integrations: [
    // Must come before mdx()
    mermaid({
      theme: "default",
      autoTheme: true, // follows <html data-theme="light|dark">
      mermaidConfig: {
        fontFamily: MERMAID_FONT,
        themeVariables: {
          fontFamily: MERMAID_FONT,
          fontSize: "16px",
        },
        flowchart: {
          curve: "basis",
          htmlLabels: true,
          padding: 18,
          subGraphTitleMargin: { top: 6, bottom: 16 },
          nodeSpacing: 40,
          rankSpacing: 48,
          useMaxWidth: true,
        },
        sequence: {
          useMaxWidth: true,
          actorMargin: 60,
          messageMargin: 36,
          mirrorActors: false,
          boxMargin: 8,
        },
        state: { useMaxWidth: true },
      },
    }),
    sitemap({
      filter: page => SITE.showArchives || !page.endsWith("/archives"),
    }),
    mdx(),
    react(),
  ],
  markdown: {
    processor: unified({
      remarkPlugins: [
        remarkToc,
        [remarkCollapse, { test: "Table of contents" }],
      ],
    }),
    shikiConfig: {
      // For more themes, visit https://shiki.style/themes
      themes: { light: "github-light", dark: "night-owl" },
      defaultColor: false,
      wrap: false,
      transformers: [
        transformerFileName({ style: "v2", hideDot: false }),
        transformerNotationHighlight(),
        transformerNotationWordHighlight(),
        transformerNotationDiff({ matchAlgorithm: "v3" }),
      ],
    },
  },
  vite: {
    plugins: [tailwindcss()],
    optimizeDeps: {
      exclude: ["@resvg/resvg-js"],
    },
  },
  image: {
    responsiveStyles: true,
    layout: "constrained",
  },
  env: {
    schema: {
      PUBLIC_GOOGLE_SITE_VERIFICATION: envField.string({
        access: "public",
        context: "client",
        optional: true,
      }),
    },
  },
});

import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { defineConfig } from "@rspress/core";
export default defineConfig({
  root: "pages",
  globalStyles: resolve("pages/guide.css"),
  outDir: "site",
  title: "Architecture Kit",
  lang: "zh",
  themeConfig: { fallbackHeadingTitle: false, sidebar: JSON.parse(readFileSync("sidebar.json", "utf8")) },
});

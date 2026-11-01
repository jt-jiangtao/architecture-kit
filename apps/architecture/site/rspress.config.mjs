import { readFileSync } from "node:fs";
import { defineConfig } from "@rspress/core";
export default defineConfig({
  root: "pages",
  outDir: "site",
  title: "Architecture Kit",
  lang: "zh",
  themeConfig: { sidebar: JSON.parse(readFileSync("sidebar.json", "utf8")) },
});

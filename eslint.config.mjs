import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

// Mirrors the checks Obsidian's community-plugin review bot runs. Use
// `npm run lint` before cutting a release so issues surface locally instead
// of in the review queue.
export default defineConfig([
  ...obsidianmd.configs.recommended,
  {
    files: ["main.ts", "src/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: "./tsconfig.json" },
    },
  },
  {
    ignores: ["node_modules/**", "main.js", "dist/**", "test-support/**", "**/*.mjs", "datadeck/**", "datadeck-work/**"],
  },
]);

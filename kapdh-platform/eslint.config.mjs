import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/.astro/**", "**/generated/**", "**/routeTree.gen.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      // Frontend tidak boleh mengimpor database, worker, atau secrets (PRD 7.2).
      "no-restricted-imports": ["error", { patterns: ["@kapdh/database", "@kapdh/database/*"] }],
    },
  },
  {
    files: ["apps/api/**", "apps/worker/**", "packages/database/**"],
    rules: { "no-restricted-imports": "off" },
  },
);

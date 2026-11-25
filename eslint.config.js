import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.venv/**",
      "**/dist/**",
      "**/target/**",
      "**/coverage/**",
      "**/gen/**",
      "app/src/generated/**",
      "eval/results/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ["**/*.{js,mjs}", "**/vite.config.ts", "**/vitest.config.ts"],
    languageOptions: { globals: { ...globals.node } },
  },
);

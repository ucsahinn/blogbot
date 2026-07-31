import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/target/**",
      "**/binaries/**",
      "**/resources/pglite/**",
      "**/coverage/**",
      "**/.serena/**",
      "**/artifacts/**",
      "**/test-results/**"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } }
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser
      }
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true }
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          "argsIgnorePattern": "^_",
          "varsIgnorePattern": "^_"
        }
      ]
    }
  }
);

import tseslint from "typescript-eslint";
import globals from "globals";
export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "vendor/**"] },
  ...tseslint.configs.recommended,
  { files: ["**/*.ts"], languageOptions: { globals: globals.node } },
  // Scripts run in the container, not through tsc: without this, a missing import is a
  // ReferenceError at the worst moment instead of a lint error.
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: globals.node, sourceType: "module" },
    // tseslint turns no-undef off because TypeScript checks it; these files never go
    // through tsc, so an undefined name must still fail the build.
    rules: { "no-undef": "error" },
  },
  {
    files: ["public/*.js"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.serviceworker },
    },
  },
  { rules: { "@typescript-eslint/no-explicit-any": "error" } },
);

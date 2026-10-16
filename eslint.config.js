import tseslint from "typescript-eslint";
import globals from "globals";
export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "vendor/**"] },
  ...tseslint.configs.recommended,
  { files: ["**/*.ts"], languageOptions: { globals: globals.node } },
  {
    files: ["public/*.js"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.serviceworker },
    },
  },
  { rules: { "@typescript-eslint/no-explicit-any": "error" } },
);

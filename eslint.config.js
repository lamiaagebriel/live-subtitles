// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: [".output/", ".wxt/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // `catch {}` is used on purpose for best-effort calls (a closed tab, a missing offscreen document)
      "no-empty": ["error", { allowEmptyCatch: true }]
    }
  }
);

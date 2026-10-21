import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = defineConfig([
  ...nextVitals,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  // The React Compiler rules came with Next 16 and flag a pattern this
  // codebase uses everywhere: a fetch inside an effect that then sets state.
  // There are ~140 of them in the tree, all of them working code, so as errors
  // they block every change that touches a file — including a fix for a real
  // bug. They stay on as warnings, so the debt is visible in the output and
  // can be paid down file by file.
  {
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/refs": "warn",
    },
  },
]);

export default eslintConfig;

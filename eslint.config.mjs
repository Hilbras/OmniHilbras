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
    // Committed CLI build artifacts (gitignored via cli/.gitignore `app/*`): minified
    // webpack bundles would drown the real signal and take minutes to lint.
    "cli/app/.next-cli-build/**",
    "cli/app/.build-home/**",
    // Root production build output (gitignored via /.next-cli-build/): minified
    // webpack bundles with react/display-name errors from minified component code.
    ".next-cli-build/**",
    "node_modules/**",
    "cli/node_modules/**",
    "tests/node_modules/**",
  ]),
  // The React Compiler rules came with Next 16 and flag a pattern this
  // codebase uses everywhere: a fetch inside an effect that then sets state.
  // There are ~140 of them in the tree, all of them working code, so as errors
  // they block every change that touches a file — including a fix for a real
  // bug. They stay on as warnings, so the debt is visible in the output and
  // can be paid down file by file.
  {
    // Scope these to the same file set where eslint-config-next registers
    // the react-hooks plugin (its config object's files glob). A .cjs file
    // (tests/unit/custom-server-h2c.test.cjs) is outside that set, so applying
    // the rules there makes ESLint fatal-error on "plugin not found".
    files: ["**/*.js", "**/*.jsx", "**/*.mjs", "**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/refs": "warn",
    },
  },
]);

export default eslintConfig;

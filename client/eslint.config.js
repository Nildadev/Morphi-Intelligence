import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // Correctness rules stay as errors (rules-of-hooks, exhaustive-deps, no-explicit-any...).
      // These two groups are migration hints from the React Compiler preset, not defects:
      //
      // - `set-state-in-effect`: every hit is the documented "mirror a prop/open state into render
      //   state" pattern (an editor draft, a focus target, a filtered empty-state flag). React allows
      //   it, and rewriting them all as render-phase adjustments would touch eight components that
      //   each have their own tests, for no user-visible change.
      // - `preserve-manual-memoization`: the compiler bailing out on an existing `useCallback`. It
      //   reports a slower memoisation, not a wrong result.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      // The app shares constants and helpers next to their component on purpose (a one-file unit is
      // easier to read than a component plus a `constants.ts` twin). Fast refresh reloads those files
      // whole; the rule is a dev-experience nicety, so it stays visible as a warning.
      'react-refresh/only-export-components': 'warn',
    },
  },
])

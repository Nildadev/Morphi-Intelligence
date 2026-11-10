# Third-Party Notices

Morphi Intelligence is licensed under the ISC License (see [`LICENSE`](LICENSE)).

This file records third-party material that has been **adapted into this repository**,
as required by the respective licenses.

---

## ZCode — design system

- **Source:** <https://github.com/zai-org/ZCode>
- **License:** Apache License 2.0 (full text: <https://www.apache.org/licenses/LICENSE-2.0>)
- **Copyright:** Z.ai

### What was adapted

| Morphi artifact | ZCode origin | Nature of use |
| --- | --- | --- |
| `DESIGN.md` | `DESIGN.md` | Document structure, the `text-ui-*` scale definition and role table, the "product character" constraints, and the rule that UI font scaling moves one variable rather than the root font size. Rewritten for Morphi's product, tokens, and enforcement tests. |
| `client/src/index.css` (`@theme` typography block) | `packages/ui/src/styles.css` (`--text-ui-*`, `--tracking-wf-label`, `--text-mobile-input-safe`) | The `calc()`-based scale formula and level names, ported additively as new tokens. |

### What was NOT taken

- No ZCode colour values, surface tokens, component code, or TypeScript modules were copied.
  Morphi's colour system predates this adaptation and is enforced by its own contrast tests
  (`client/tests/tokens.test.ts`).
- No ZCode runtime dependency was added.

Apache-2.0 requires that adaptations retain this attribution and the license notice. The
`text-ui-*` names and scale remain under Apache-2.0; the surrounding Morphi design system
remains under the ISC License.

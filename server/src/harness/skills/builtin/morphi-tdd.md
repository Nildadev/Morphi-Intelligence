---
name: morphi-tdd
description: RED-GREEN-REFACTOR for Luau; no production script before a failing assertion.
triggers: /tdd, test first, viết test, kiểm thử, red green, tdd
---
## Skill: RED-GREEN-REFACTOR

Write the failing assertion first. Watch it fail. Write the smallest correct change. Watch it pass.

1. RED — express the expected behaviour as an executable check (an assertion script, a Studio
   execution that returns the observed value, or an explicit before/after comparison). Run it and
   capture the ACTUAL failure. A check that passes immediately proves nothing: fix the check.
2. GREEN — change only what the failing check demands. No refactor, no cleanup, no extra options.
3. REFACTOR — with the check green, remove duplication and improve names. Re-run the check.
4. Delete any implementation written before its failing check existed and start that step over.

Roblox specifics: verify behaviour at runtime, not only by reading source. A clean lint report is not
evidence of behaviour. Re-read a script after writing it; never claim a write succeeded from the
absence of an error alone.

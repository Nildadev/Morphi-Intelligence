---
name: morphi-verify
description: Evidence over claims; no completion statement without a fresh verification result.
triggers: /verify, kiểm chứng, xác minh, đã xong chưa, verify, kiểm tra lại
---
## Skill: evidence before completion

A claim of success requires a fresh result produced in this turn.

Before saying "done", "fixed", "works" or "should be fine":
1. Identify the exact check that would disprove the claim (re-read the script, run the assertion,
   query the instance, inspect the output log).
2. Run it now, in full. Read the output and the exit/status.
3. Report the measured result, not the intention. Quote the value you observed.
4. Check neighbouring behaviour did not regress.

Forbidden: "should work", "probably", "looks correct", "assuming the script saved", reusing an
earlier run's green result, or trusting that a tool call succeeded because it did not throw.
Fix the product when a check fails; never loosen the check to make it pass. A contrast/lint/type
failure that only appears under a hidden page or stale snapshot is a harness artifact: re-run it
correctly instead of changing a correct value.

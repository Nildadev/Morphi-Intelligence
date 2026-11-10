---
name: morphi-workflow
description: The mandatory end-to-end loop, from intent to verified delivery.
triggers: /workflow, quy trình, workflow, superpowers, làm cho đúng, end to end
---
## Skill: the working loop

Skills are mandatory workflows, not suggestions. Run the loop in order; skip a phase only when the
step is genuinely trivial, and say which phase was skipped and why.

1. BRAINSTORM — intent, constraints, observable definition of done. Get sign-off on a short spec.
2. PLAN — bite-sized steps with exact targets and a verification step each.
3. RED — write the failing assertion and watch it fail.
4. GREEN — smallest correct change, watch the assertion pass.
5. REVIEW — compare against the plan; a Critical finding sends the step back.
6. VERIFY — fresh evidence for every completion claim; check neighbours for regressions.
7. REPORT — what changed, what was measured, what remains open. No unsupported success language.

Between two steps, prefer a short checkpoint over a long silent run. When a blocker appears (missing
tool, unclear instruction, failing check twice), stop and ask instead of guessing. Autonomy is for
executing an agreed plan, not for inventing a new one.

Anti-vibe-code rules that apply in EVERY phase: inspect real state instead of assuming; never invent
paths, counts, versions or Studio state; fix the product rather than loosen an assertion; one small
behaviour per step; no fake data, placeholder numbers or dead controls (design spec §6.6.2).

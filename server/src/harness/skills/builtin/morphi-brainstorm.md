---
name: morphi-brainstorm
description: Establish intent and a short spec before writing any Luau.
triggers: /brainstorm, ý tưởng, làm tính năng, tính năng mới, thiết kế, yêu cầu, feature, design
---
## Skill: intent before implementation

Do not jump into writing Luau. First establish what the user is actually trying to build and why.

1. Ask about the observable behaviour, the affected place/instances, and what "done" means.
2. Play the understanding back in short chunks the user can correct: goal, scope, constraints, out of scope.
3. Inspect the REAL project state with read tools. Never assume a script, instance or service exists.
4. Only after the user agrees on that short spec may a plan or code be produced.
5. Apply YAGNI: drop speculative features, abstractions and configuration knobs.

If the request is already unambiguous and tiny (a one-line fix with an obvious target), state the
one-sentence spec inline instead of asking, then continue. Asking for ceremony on a trivial change is
also a failure of this skill.

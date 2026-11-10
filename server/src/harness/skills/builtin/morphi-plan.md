---
name: morphi-plan
description: Break approved work into bite-sized steps with exact paths and a verification step each.
triggers: /plan, kế hoạch, plan, chia bước, triển khai, implement
---
## Skill: bite-sized plan

Turn the agreed spec into steps small enough to be checked one at a time. A step is not a heading;
it is one behaviour with a file path and a way to prove it.

For each step record:
- the exact target (script path / instance path / RemoteEvent name), read from the project, not guessed;
- the single behaviour that changes;
- the check that proves it, with the tool call or command that produces the evidence;
- what must stay unchanged.

Rules:
- No step may contain "and" in its name; split it.
- No invented paths, counts, asset ids, version numbers or Studio state.
- Do not deviate from the approved plan while executing. A discovery that invalidates the plan stops
  work and returns to brainstorming; silently improvising a different design is vibe coding.
- Keep the plan visible in the reply so the user can see progress against it.

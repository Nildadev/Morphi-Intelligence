---
name: morphi-review
description: Review the change against the agreed plan and report findings by severity.
triggers: /review, review, rà soát, kiểm duyệt, soát lại
---
## Skill: review against the plan

Review the delivered change against the spec and plan, not against how pleasant the code looks.

For every finding report: severity (Critical / Important / Minor), the exact file or instance you
actually opened, the command or tool output that proves it, and the smallest corrective action.
A Critical finding blocks completion.

Check in this order:
1. Does each planned step exist, with its verification evidence?
2. Is any claim in the summary unsupported by a measurement?
3. Did the change introduce paths, numbers, labels, counts or status text that were never observed?
4. Did an assertion get weakened instead of the product getting fixed?
5. Is there speculative code beyond what the failing check demanded (YAGNI)?

Do not reopen settled findings from earlier rounds unless a new measurement contradicts them.
Write the verdict to a durable surface when the workflow asks for one, not only into chat.

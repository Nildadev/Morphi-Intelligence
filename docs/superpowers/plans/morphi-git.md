# Morphi Git-like history and undo plan

## Goal

Morphi needs Git-like operations for two coupled histories:

1. **Conversation history** — user message → AI reply → tool calls → reasoning.
2. **Roblox Studio workspace history** — scripts, instances, properties, and place changes made by AI.

An “undo” from a user message must do both in one atomic-feeling operation: revert the conversation branch and, when a checkpoint exists, offer/perform a Studio restore. Do not pretend a tool side effect is undoable if the inverse is not known.

## Model

Mor phi should keep the append-only session event log as the source of truth and model undo like a Git reset/branch:

- A `session/revert` event records `toSeq` (the last event kept).
- The projection excludes the suffix `(toSeq, revertSeq)` and includes events after the revert event.
- Multiple reverts compose by excluding each suffix; post-revert messages are a new branch.
- The log is never rewritten. Redo is possible by switching back to the pre-revert branch/session, and future work can be implemented as an explicit branch session if desired.

## Phase 1 — implemented MVP: chat undo

Implemented:

- Server:
  - Event type `session/revert { toSeq }`.
  - `effectiveEvents(events)` in `projections.ts` excludes reverted suffix ranges.
  - `deriveMessages`, `deriveSteps`, and `SessionStore.get` use effective events so chat, goal, plan, todos, and compaction context do not resurrect undone history.
  - `POST /api/sessions/:id/undo-message` finds the `user/message` event, appends `session/revert` to `seq - 1`, and returns the shortened `SessionDetail`.
  - Busy sessions refuse undo with `409 SESSION_BUSY`.
- Client:
  - `api.sessions.undoMessage(sessionId, messageId)`.
  - `chatReducer` handles `session/revert` by dropping rows whose known `seq` is past `toSeq`.
  - `ChatView` passes `onUndoMessage` only to settled user rows.
  - `MessageItem` renders a `Hoàn tác` button under the user bubble; it aborts any in-flight turn, calls the route, and reloads the session.
  - Tests cover projection semantics, route behavior, reducer behavior, and the undo button.

Limit: Phase 1 reverts conversation/context, not Studio workspace mutations.

## Phase 1.5 — implemented: session branch / redo path

Implemented:

- `EventStore.copy(sourceId, targetId, upToSeq)` copies a durable log prefix.
- `POST /api/sessions/:id/branch` creates a new visible checkout session and copies effective events up to `toSeq`.
- `api.sessions.branch(id, toSeq?)` exposes it to the client.
- Tests pin that branch creation returns only the copied prefix and leaves the source session intact.

Limit: Branching is currently an API/engine capability; a history-browser button can open the branch or record it in the UI as the next step.

## Phase 2 — Studio script/content checkpoints

Add an immutable checkpoint system:

- `workspace_checkpoints`
  - `id`
  - `session_id`
  - `created_at`
  - `label`
  - `base_event_seq`
  - `root_hash`
  - `manifest_ref` (content-addressed JSON blob)
- Manifest entries:
  - Script instances: full path/name/class, source hash, source content or content-addressed blob.
  - Instance properties: path, property name, old value, new value.
  - Inserted instances: id/path/class, properties needed for deletion/restore.
  - Deleted instances: parent, class, properties, children needed for recreation.
- Before a mutating Studio tool runs, capture a preflight checkpoint for candidate targets:
  - `script_read` / `script_grep` / `inspect_instance` / `search_game_tree` snapshots.
  - `multi_edit` targets and old/new source where available.
  - `execute_luau` snapshots are required unless the tool is explicitly marked irreversible.
- After tool success, store a post-checkpoint and a diff:
  - Added/deleted/changed scripts and properties.
  - New/changed/deleted place objects.
  - Tool args/result hashes for auditability.

## Phase 3 — inverse/restore engine

Implement restore as a planned transaction, not a silent overwrite:

1. Validate checkpoint and current Studio link.
2. Diff checkpoint manifest against current state.
3. Produce an inverse plan:
   - Script source → restore old source.
   - Existing property → restore old value.
   - Inserted instance → delete the instance.
   - Deleted instance → recreate from stored properties/children when possible.
4. Ask approval for medium/high-risk restores.
5. Execute inverses in reverse dependency order.
6. Re-read affected targets and run Play/console verification.
7. Mark checkpoint `restored` only after verification; otherwise mark `restore-failed` with exact failed entry.

## Phase 4 — history UI

- Turn timeline rows gain:
  - Commit/checkpoint id.
  - Diff summary.
  - `Hoàn tác` for chat.
  - `Restore` / `Branch` for Studio checkpoints.
- A checkpoint browser lists:
  - Turn.
  - Timestamp.
  - Changed files/instances count.
  - Diff preview.
  - Restore / branch / compare buttons.
- Redo is branch switching, not resurrecting deleted events in the same session.

## Safety rules

- No fake “undone” status: if an MCP tool has no inverse recorded, the UI must say it cannot safely restore that change.
- Undo is blocked while a turn is running.
- Studio restore requires a linked Studio and visible plan before execution.
- Manual user edits to Studio after a checkpoint are never silently overwritten; restore stops and reports drift.
- Compaction and next-turn context must use effective (post-revert) events only.

## Phase 2 — implemented so far (audit foundation)

Implemented:

- `workspace_checkpoints` table (`id`, `session_id`, `created_at`, `label`, `base_event_seq`, `root_hash`, `manifest`, `status`).
- `CheckpointStore` (`server/src/harness/checkpoints/store.ts`): content-addressed manifest (`sha256`), newest-first list, `hashArgs`, best-effort `extractTargets`.
- `ToolPipeline` records one checkpoint per mutating Studio tool call (`studio.*` with risk ≠ `low`) after execution, with tool name, call id, args hash, targets, outcome, and `restorable: false` + explicit reason (no pre-state snapshot → no inverse claimed).
- `GET /api/sessions/:id/checkpoints` lists a session's checkpoints.
- Tests cover store round-trip/hash, target extraction, pipeline recording (mutating only), and the route.

Not yet implemented (deliberately not faked):

- Pre-mutation state snapshots (script source, instance properties) via MCP reads.
- Inverse/restore engine (Phase 3), diff rendering, and the history browser UI (Phase 4).

## Post-Phase-2 notes (live verified)

- `resolveAuto` breaks context-window ties by model generation, so `auto` no longer picks a retired generation the key can no longer call (Google still lists `gemini-2.5-flash` for keys that answer 404 "no longer available to new users"); pinned in `registry.test.ts`.
- Sidebar rows of sessions with a live turn carry animated running dots (`session-running-<id>`): a turn belongs to its session, so a background chat announces that it is still working.

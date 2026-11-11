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

Not yet implemented at the time (all since completed — see Phase 3/4 below):

- ~~Pre-mutation state snapshots (script source, instance properties) via MCP reads.~~ **Done in Phase 3.**
- ~~Inverse/restore engine (Phase 3)~~ **Done in Phase 3.**
- ~~Client history browser + diff rendering (Phase 4)~~ **Done in Phase 4.**

## Phase 3 — implemented: pre-state snapshots + restore engine (live-verified on real Studio)

Implemented:

- `server/src/harness/checkpoints/studioWire.ts` — the ONLY module that knows the real Studio MCP
  wire shape. Lives separately so the engine never hardcodes tool names.
  - `readScriptSource` / `writeScriptSource` / `inspectInstance` / `deleteInstance` /
    `setInstanceProperties`, plus `restorableProperties` and `propertiesFrom` / `scriptSourceFrom`
    parsers.
  - **Measured live on `Place1`** (Roblox Studio MCP server, 36 tools): the real surface is
    `script_read` (`target_file`, returns line-numbered `N→` text), `multi_edit` (`file_path`,
    `edits:[{old_string,new_string}]`, `datamodel_type`), `inspect_instance` (returns a JSON
    *text* string with a `.properties` bag), `execute_luau`. There is NO `studio.write_script` /
    `studio.delete_instance` / `studio.set_properties` — those were the *guessed* names the
    engine originally used and which failed on a real place (caught only by the live probe).
  - Legacy `studio.*` aliases are still accepted (fake/E2E gateway returns a raw `{source}` /
    `{properties}` object), so the 696/727 server tests keep passing unchanged.
- `server/src/harness/checkpoints/snapshot.ts`
  - `snapshotPreState(mcp, toolName, args)` runs BEFORE the mutating call and reads what the
    call is about to overwrite, via `studioWire`:
    - script writes → `readScriptSource` (strips the `N→` gutter);
    - inserts (`insert_asset` / `insert_instance`, and a create with no readable old source) →
      the inverse is a delete of the inserted path (Luau `:Destroy()`);
    - other mutating tools → `inspectInstance` property bag, filtered by `restorableProperties`
      (only scalars round-trip safely; see below).
  - `isRestorable` is true only when EVERY touched target produced an inverse step. A single
    unreadable target downgrades the whole checkpoint — a partial restore is not an undo.
  - Every refusal writes a specific Vietnamese reason (which tool, which path, why).
- `server/src/harness/checkpoints/restore.ts`
  - `previewRestore` re-reads the live workspace and returns the inverse plan plus drift notes;
    refuses `NOT_FOUND`, `NOT_RESTORABLE`, `STUDIO_NOT_CONNECTED`, `ALREADY_RESTORED`,
    `IN_PROGRESS`.
  - `applyRestore` writes each inverse (via `studioWire`), then RE-READS to verify. A tool
    answering OK is not proof: mismatched read-back marks the checkpoint `restore-failed`.
  - Drift found in the preview is a refusal, so a hand edit made after the checkpoint is never
    overwritten (plan safety rule).
  - `restoreTurn` batches several call ids as ONE transaction: previews every candidate, and if
    ANY drifts it refuses the whole turn before writing — half-restoring a turn is worse than
    refusing.
  - `RestoreSkipped[]` threads per-key property refusals (see below) so a refused property is
    reported, never counted as a mismatch.
  - Status is one-way: `recorded` → `restoring` → `restored` | `restore-failed`.
- Routes: `GET /api/sessions/:id/checkpoints/:checkpointId/restore` (preview, read-only),
  `POST …/restore` (apply), `POST /api/sessions/:id/undo-turn` (batch restore by call ids).
  A checkpoint from another session is a 404.
- `server/src/harness/checkpoints/liveProbe.test.ts` — **gated behind `MORPHI_LIVE_STUDIO=1`**
  (spawns the real `StudioMCP.exe`, writes to the open place, cleans up after itself). This is the
  test that caught three bugs fakes could never expose (see "Live-verified bugs" below). CI stays
  green without it.

Live-verified bugs (caught by the probe, not by fakes):

1. `multi_edit` with `old_string: ''` **appends**, it does not replace — a "full rewrite" would
   have corrupted every restored script. `writeScriptSource` reads current source and uses it as
   `old_string`; empty string is used only to create.
2. `deleteInstance` reported success while deleting nothing (returned `"deleted"` unconditionally
   and emitted a JSON-array literal, which is not valid Luau). Now emits a proper table, uses
   `GetService`/`FindFirstChild`, and verifies the instance is gone.
3. Child lookup by `root[name]` threw on a missing name, making "gone" indistinguishable from
   "failed". Now resolves via `FindFirstChild` (`GetService` for the service segment).
4. Property restore was completely broken: `inspect_instance` returns a lossy bag (a plain Part:
   36 keys, only 16 writable; 20 throw — pseudo-paths, Vector3/enum/BrickColor string round-trips,
   capability-locked). The first fix kept only number+boolean scalars; the final fix keeps ALL
   scalars (strings included) and uses per-key `pcall` isolation, reporting each refusal with
   Studio's own message via `HttpService:JSONEncode`. Verified live: `CollisionGroup "Default"`
   → mutated → restored, with `skipped` non-empty (incl. `UniqueId`).

## Phase 4 — implemented: history UI + drift visibility (live-verified)

Implemented:

- `server/src/routes/sessions.ts` — `POST /api/sessions/:id/undo-turn` covered by `routes.test.ts`
  (fake MCP): empty list → 400, `NOTHING_TO_RESTORE` → 409, cross-call 404.
- `client/src/lib/api.ts` — `checkpoints`, `previewRestore`, `restore`, `undoTurn`.
- `client/src/components/chat/TurnWorkSummary.tsx` — framed "N script thay đổi +A −D" row at the
  end of a turn, collapsed by default, with the **Undo** button (Phase 4 continued commit
  `2a1eac0`).
- `client/src/components/chat/HistoryPanel.tsx` — checkpoint browser: lists checkpoints newest
  first (time, tool, first target, server `restoreReason`), two-step preview → confirm restore,
  a dirty preview disables confirm so hand edits are not overwritten. First tests added
  (`HistoryPanel.test.tsx`).
- `client/src/components/chat/RestoreNotice.tsx` (new) — inline transcript alert +
  pure `undoNoticeOf(result)`; shows drift / partial-failure / skipped verbatim, dismissible.
  `ChatInterface.handleUndoTurn` sets a transcript notice for drift/partial/skipped (the toast is
  kept only as a pointer and for success). `types.ts` adds `skipped?: RestoreSkipped[]`; `vi.ts`
  adds `undoSkipped`, `dismissNotice` (both consumed — no orphan keys).
- `Rail.tsx` 'history' action → `SidePanel` already wired (verified, not rebuilt).

Property drift comparison: `detectDrift` re-inspects every property target and compares the keys
the snapshot recorded; a changed key is drift for a batch (turn) restore. Script source is diffed
exactly. This is no longer "only script source" — the note in the preview now says what it actually
checked.

## Remaining gaps (documented, intentionally not done)

- **True HTTP end-to-end undo through the running app** is not run: it needs an authenticated
  launch. The route is covered by `routes.test.ts` with a fake MCP, and the engine is covered live
  by `liveProbe.test.ts`. Wiring a live session through the Electron app would validate the full
  path but is out of scope for this pass.
- **BrickColor / Size / CFrame / UniqueId surface as `skipped`** with Studio's message rather than
  being silently dropped or falsely restored. Making them restorable would need typed reconstruction
  (Vector3/Color3/BrickColor), which the wire does not give us — `inspect_instance` serialises them
  as strings that Luau rejects. Per-key isolation already reports the refusal instead of failing the
  whole restore.
- **Deleted-instance recreation** from children/properties is not attempted: an inserted instance's
  inverse is a delete (reliable), not a recreate, so undoing an insert removes it rather than
  rebuilding its subtree. Capturing children for recreation would need a separate snapshot shape.

## Verification gate (last green run)

- `server tsc --noEmit` clean; `server vitest` **727 passed / 4 skipped** (4 skip = live probe).
- `MORPHI_LIVE_STUDIO=1 npx vitest run src/harness/checkpoints/liveProbe.test.ts` → **4/4 passed**
  on real `Place1` (tools present / no guessed names; script restore snapshot→mutate→undo→read-back;
  property restore incl. string `CollisionGroup` + `skipped` non-empty).
- `client tsc -b` clean; `client vitest` **631 passed**.
- `Place1` verified CLEAN after every live run (no leftover probe scripts/instances).

## Post-Phase-2 notes (live verified)

- `resolveAuto` breaks context-window ties by model generation, so `auto` no longer picks a retired generation the key can no longer call (Google still lists `gemini-2.5-flash` for keys that answer 404 "no longer available to new users"); pinned in `registry.test.ts`.
- Sidebar rows of sessions with a live turn carry animated running dots (`session-running-<id>`): a turn belongs to its session, so a background chat announces that it is still working.

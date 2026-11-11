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

## Live HTTP end-to-end (Phase 5 — closed the two last gaps)

`server/scripts/e2e-live-undo.mjs` drives the whole path over HTTP against a real place: seed
`ServerScriptService.MorphiE2E` = `local V = 1` → `POST /api/chat/stream` with `/script
studio-real-edit` (fake LLM emits one `studio.multi_edit`) → the live script becomes `local V = 2`
→ checkpoint is `restorable: true` → `POST /api/sessions/:id/undo-turn` → the live script reads back
as `local V = 1` **through Studio's own MCP server**, not through our API. Run it with the server in
`MORPHI_FAKE_LLM=1 MORPHI_FAKE_SCRIPT=studio-real-edit MORPHI_LIVE_STUDIO=1` mode and
`POST /api/mcp/reconnect` first (the gateway connects lazily); the script seeds and cleans its own
fixture. Last run: **11/11 PASS, E2E OK** on `Place1`.

Three real bugs only this probe could find (unit tests called the loop/gateway directly and stayed
green):

- **Real-vs-legacy shape was decided by name prefix.** `ServiceMcpGateway` publishes the real tools
  PREFIXED (`studio.script_read`, `studio.multi_edit`) while forwarding the real schemas, so the
  prefix test made every snapshot read miss and no checkpoint was ever restorable. `studioWire.ts`
  now decides from the advertised schema (`target_file` / `file_path` / `code`) and falls back to
  "unprefixed ⇒ real", pinned by `studioWire.test.ts` + `snapshot.test.ts`.
- **`studio-real-edit` fake args were not schema-valid:** `multi_edit` requires `datamodel_type`, so
  the turn died with `INVALID_ARGS: data must have required property 'datamodel_type'` and never
  mutated anything. The fixture now sends `file_path` + `datamodel_type: 'Edit'` + `edits`.
- **`POST /chat/stream` dropped `permissionMode`.** The composer sends the three-way approval switch
  on every message; the route accepted the field and never forwarded it into `AgentTurnInput`, so
  `full` behaved like `balanced` and every `ask`-risk tool (including `multi_edit`) waited out its
  approval timeout and settled as `APPROVAL_DENIED`. Fixed in `routes/chat.ts`, pinned by
  "permissionMode full runs an ask-risk tool without any approval request" in `chat.test.ts`.

Value reconstruction from the lossy `inspect_instance` string is now handled where it is
unambiguous: `reconstructValue` rebuilds `Vector3.new(x, y, z)` from a numeric triple and
`BrickColor.new("Medium stone grey")` from a multi-word name, and leaves single-word strings
(`CollisionGroup: "Default"`) as plain strings so a real string property is never turned into a
BrickColor. `setInstanceProperties` still isolates every key in its own `pcall` and reports refusals.

## Remaining gaps (documented, intentionally not done)

- **Enum / `CFrame` rotation / `UniqueId` still surface as `skipped`** with Studio's own message.
  `Vector3`/`Color3` triples and `BrickColor` names are now reconstructed, but `"Enum.Material.Plastic"`
  would need a `Enum.Material.Plastic` literal and `CFrame.Rotation` is a pseudo-path that is not a
  member at all — both stay refused-and-reported rather than guessed.
- **Deleted-instance recreation** from children/properties is not attempted: an inserted instance's
  inverse is a delete (reliable), not a recreate, so undoing an insert removes it rather than
  rebuilding its subtree. Capturing children for recreation would need a separate snapshot shape.

## Verification gate (last green run)

- `server tsc --noEmit` clean; `server vitest` **733 passed / 5 skipped** (5 skip = live probe).
- `MORPHI_LIVE_STUDIO=1 npx vitest run src/harness/checkpoints/liveProbe.test.ts` → **5/5 passed**
  on real `Place1` (script restore snapshot→mutate→undo→read-back; property restore incl. string
  `CollisionGroup` + `skipped`; Vector3/BrickColor reconstruction restored and re-inspected).
- `node scripts/e2e-live-undo.mjs` against the live server → **11/11 PASS** (see above).
- `client tsc --noEmit` clean; `client vitest` **631 passed**.
- `Place1` verified CLEAN after every live run (no leftover probe scripts/instances).

## Post-Phase-2 notes (live verified)

- `resolveAuto` breaks context-window ties by model generation, so `auto` no longer picks a retired generation the key can no longer call (Google still lists `gemini-2.5-flash` for keys that answer 404 "no longer available to new users"); pinned in `registry.test.ts`.
- Sidebar rows of sessions with a live turn carry animated running dots (`session-running-<id>`): a turn belongs to its session, so a background chat announces that it is still working.

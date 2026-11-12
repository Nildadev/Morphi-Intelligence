import { describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import { createTestDb } from '../../../test/db';
import { CheckpointStore } from './store';
import { applyRestore, previewRestore } from './restore';
import { snapshotPreState } from './snapshot';
import { deleteInstance, inspectInstance, readScriptSource, writeScriptSource } from './studioWire';

/**
 * LIVE probe against a running Roblox Studio.
 *
 * Gated: it only runs with `MORPHI_LIVE_STUDIO=1`, because it needs Studio open with a place loaded
 * and it writes to that place (then cleans up after itself). CI stays green without it.
 *
 *     MORPHI_LIVE_STUDIO=1 npx vitest run src/harness/checkpoints/liveProbe.test.ts
 *
 * Why it exists: the engine was only ever proved against fakes. These assertions are the ones that
 * would have caught the guessed tool names (`studio.write_script`, …) before this adapter.
 */

const gated = process.env.MORPHI_LIVE_STUDIO === '1';

/** Unique probe name so a failed run never collides with a leftover from an earlier one. */
function probeId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Newest `StudioMCP.exe` Roblox ships, matching `resolveOfficialMcpServer`'s own preference. */
function findStudioMcp(): string | null {
  if (process.env.MORPHI_STUDIO_MCP && fs.existsSync(process.env.MORPHI_STUDIO_MCP)) {
    return process.env.MORPHI_STUDIO_MCP;
  }
  const root = `${process.env.LOCALAPPDATA ?? ''}/Roblox/Versions`;
  try {
    const candidates = fs.readdirSync(root)
      .filter((entry) => /^version-/i.test(entry))
      .map((entry) => `${root}/${entry}/StudioMCP.exe`)
      .filter((file) => fs.existsSync(file))
      .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return candidates[0]?.file ?? null;
  } catch {
    return null;
  }
}

/** Normalise an MCP tool result the way `serviceGateway` does: flatten `content[].text`. */
function resultText(result: unknown): string | undefined {
  if (result === null || typeof result !== 'object') return undefined;
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  if (!Array.isArray(content)) return undefined;
  const texts = content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text!);
  return texts.length > 0 ? texts.join('\n') : undefined;
}

interface Live {
  child: ChildProcessWithoutNullStreams;
  request(method: string, params?: unknown): Promise<any>;
  close(): void;
}

function connect(exe: string): Live {
  const child = spawn(exe, ['--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map<number, (msg: any) => void>();
  let nextId = 0;

  rl.on('line', (line) => {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)!(msg);
      pending.delete(msg.id);
    }
  });

  const request = (method: string, params?: unknown): Promise<any> => {
    const id = ++nextId;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 30000);
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    });
  };

  return { child, request, close: () => child.kill() };
}

describe.skipIf(!gated)('live Studio wire (MORPHI_LIVE_STUDIO=1)', () => {
  const exe = gated ? findStudioMcp() : null;

  /** A gateway that forwards to the real server, mirroring serviceGateway's return contract. */
  async function liveGateway() {
    const live = connect(exe!);
    const init = await live.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'morphi-live-probe', version: '1' },
    });
    expect(init.result?.serverInfo?.name).toBe('RobloxStudio');
    live.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);

    const listed = await live.request('tools/list', {});
    const tools = (listed.result?.tools ?? []) as Array<{ name: string; parameters?: unknown }>;

    const gateway = {
      connected: true,
      studioLinked: true,
      server: { source: 'studio-builtin' as const, path: exe!, version: '1' },
      studio: { id: 'live', name: 'live' },
      toolCount: tools.length,
      lastError: null,
      listTools: async () => tools.map((tool) => ({ name: tool.name, description: '', parameters: { type: 'object' } })),
      callTool: async (name: string, args: unknown) => {
        const answer = await live.request('tools/call', { name, arguments: args });
        if (answer.error) throw new Error(answer.error.message ?? `MCP error in ${name}`);
        if (answer.result?.isError) throw new Error(resultText(answer.result) ?? `${name} reported an error`);
        const text = resultText(answer.result);
        return text === undefined ? answer.result : text;
      },
      reconnect: async () => undefined,
      close: async () => undefined,
    };
    // Studio publishes a session to the proxy only after the client has been connected for a moment, and
    // `tools/list` answers from Roblox's cached listing whether or not a studio is there. Without this wait
    // the first real call can race that publication and fail with "No Roblox Studio instances are
    // connected" (MEASURED: the same file passes 5/5 while another long-lived client holds the session, and
    // fails 1/5 when the probe is the first client after a Studio restart). Poll a trivial call instead of
    // sleeping a fixed time.
    const deadline = Date.now() + 20000;
    for (;;) {
      try {
        // `inspect_instance` needs no arguments a session could reject, so a failure here is about the
        // session itself. (`execute_luau` is not usable for this: it answers `datamodel_type is required`
        // on a live session too, which says nothing about whether Studio is attached.)
        await gateway.callTool('inspect_instance', { path: 'Workspace' });
        break;
      } catch (error) {
        if (Date.now() > deadline) {
          live.close();
          throw new Error(`Studio never published a session to the MCP proxy within 20s: ${error instanceof Error ? error.message : String(error)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    return { gateway, live, tools };
  }

  it('exposes the tools the adapter targets and none of the guessed ones', async () => {
    const { live, tools } = await liveGateway();
    const names = new Set(tools.map((tool) => tool.name));
    for (const real of ['script_read', 'multi_edit', 'inspect_instance', 'execute_luau']) {
      expect(names.has(real), `missing real tool ${real}`).toBe(true);
    }
    for (const guessed of ['write_script', 'edit_script', 'create_script', 'delete_instance', 'set_properties']) {
      expect(names.has(guessed), `guessed tool ${guessed} must not exist`).toBe(false);
    }
    live.close();
  }, 60000);

  it('reads source through the `N→` gutter, so the snapshot matches what a restore writes back', async () => {
    const { gateway, live } = await liveGateway();
    const path = `ServerScriptService.MorphiProbe${probeId()}`;
    try {
      await writeScriptSource(gateway, path, 'local V1 = 1\nreturn V1', undefined, { className: 'Script' });
      const read = await readScriptSource(gateway, path);
      // The gutter must be gone, or every restore would write "     1→…" back into the script.
      expect(read).toBe('local V1 = 1\nreturn V1');
      expect(read).not.toContain('→');
    } finally {
      // Do not swallow a failed cleanup: a probe that leaves scripts behind is a bug in `deleteInstance`.
      await deleteInstance(gateway, path).catch((error) => {
        console.error('cleanup failed for', path, error instanceof Error ? error.message : error);
      });
      live.close();
    }
  }, 60000);

  it('restores a real script end-to-end: snapshot -> mutate -> undo -> read back', async () => {
    const { gateway, live } = await liveGateway();
    const db = createTestDb();
    db.prepare('INSERT INTO projects (id, name, created_at, last_active) VALUES (?, ?, ?, ?)').run('p1', 'P', 1, 1);
    db.prepare('INSERT INTO sessions (id, project_id, created_at, last_updated) VALUES (?, ?, ?, ?)').run('s1', 'p1', 1, 1);
    const store = new CheckpointStore(db);
    const path = `ServerScriptService.MorphiProbe${probeId()}`;
    const v1 = 'local V1 = 1\nprint(V1)';
    const v2 = 'local V2 = 2\nprint(V2)';

    try {
      // 1. The place starts at v1.
      await writeScriptSource(gateway, path, v1, undefined, { className: 'Script' });
      expect(await readScriptSource(gateway, path)).toBe(v1);

      // 2. The pipeline snapshots BEFORE the mutation — exactly as `pipeline.ts` calls it.
      const preState = await snapshotPreState(gateway, 'multi_edit', {
        file_path: path,
        datamodel_type: 'Edit',
        edits: [{ old_string: '', new_string: v2 }],
      });
      expect(preState.entries).toEqual([{ kind: 'script', path, source: v1 }]);
      expect(preState.notes).toEqual([]);

      const checkpoint = store.record({
        sessionId: 's1',
        label: 'live edit',
        manifest: {
          tool: 'multi_edit',
          callId: 'live-call',
          argsHash: 'h',
          targets: [path],
          outcome: 'ok',
          preState,
          restorable: true,
          restoreReason: 'ok',
        },
      });

      // 3. The mutation lands.
      await writeScriptSource(gateway, path, v2);
      expect(await readScriptSource(gateway, path)).toBe(v2);

      // 4. Preview must be clean, then the restore writes v1 back and verifies by read-back.
      const previewed = await previewRestore(gateway, store, checkpoint.id);
      expect(previewed.ok).toBe(true);
      if (previewed.ok) expect(previewed.preview.clean).toBe(true);

      const restored = await applyRestore(gateway, store, checkpoint.id);
      expect(restored.ok).toBe(true);
      if (!restored.ok) return;
      expect(restored.result.status).toBe('restored');
      expect(restored.result.failed).toEqual([]);

      // The proof a fake cannot give: Studio itself now holds v1 again.
      expect(await readScriptSource(gateway, path)).toBe(v1);
      expect(store.get(checkpoint.id)?.status).toBe('restored');
    } finally {
      const cleaned = await deleteInstance(gateway, path).catch((error) => {
        console.error('cleanup failed for', path, error instanceof Error ? error.message : error);
        return false;
      });
      expect(cleaned, 'the probe script must be removed from the place').toBe(true);
      expect(await readScriptSource(gateway, path)).toBeNull();
      live.close();
    }
  }, 90000);

  it('restores properties end-to-end: snapshot -> mutate -> restore -> re-inspect', async () => {
    const { gateway, live } = await liveGateway();
    const db = createTestDb();
    db.prepare('INSERT INTO projects (id, name, created_at, last_active) VALUES (?, ?, ?, ?)').run('p1', 'P', 1, 1);
    db.prepare('INSERT INTO sessions (id, project_id, created_at, last_updated) VALUES (?, ?, ?, ?)').run('s1', 'p1', 1, 1);
    const store = new CheckpointStore(db);
    const name = `MorphiProbe${probeId()}`;
    const path = `Workspace.${name}`;

    const luau = async (code: string): Promise<string> => String(await gateway.callTool('execute_luau', { code, datamodel_type: 'Edit' }));
    const exists = async (): Promise<boolean> =>
      (await luau(`return game:GetService("Workspace"):FindFirstChild(${JSON.stringify(name)}) == nil and "missing" or "exists"`)).trim() === 'exists';

    try {
      // 1. A real instance in the real place, at known values.
      const created = await luau([
        'local part = Instance.new("Part")',
        `part.Name = ${JSON.stringify(name)}`,
        'part.Transparency = 0',
        'part.Anchored = true',
        'part.CollisionGroup = "Default"',
        'part.Parent = game:GetService("Workspace")',
        'return "ok"',
      ].join('\n'));
      expect(created.trim()).toBe('ok');

      // 2. Snapshot through the ENGINE's own path (the pipeline snapshots before a property write).
      const preState = await snapshotPreState(gateway, 'studio.set_property', { path });
      expect(preState.notes).toEqual([]);
      const entry = preState.entries[0];
      expect(entry?.kind).toBe('properties');
      if (entry?.kind !== 'properties') return;
      expect(entry.properties.Transparency).toBe(0);
      expect(entry.properties.Anchored).toBe(true);
      // STRING properties are candidates now: `CollisionGroup` must survive the snapshot, or a
      // string restore is silently impossible. (Lossy keys stay candidates too and get skipped at
      // write time with Studio's own reason — see the `skipped` assertions below.)
      expect(entry.properties.CollisionGroup).toBe('Default');
      // The lossy keys must have been dropped, or the restore throws on `CFrame.Rotation`.
      expect(Object.keys(entry.properties).some((key) => key.includes('.'))).toBe(false);

      const checkpoint = store.record({
        sessionId: 's1',
        label: 'live property edit',
        manifest: {
          tool: 'studio.set_property',
          callId: 'live-property-call',
          argsHash: 'h',
          targets: [path],
          outcome: 'ok',
          preState,
          restorable: true,
          restoreReason: 'ok',
        },
      });

      // 3. Mutate with Luau — a number, a boolean AND a string — then prove it landed so a passing
      // restore cannot be a no-op.
      const customGroup = `MorphiProbeGroup${probeId()}`;
      const mutated = await luau([
        `local part = game:GetService("Workspace"):FindFirstChild(${JSON.stringify(name)})`,
        'if part == nil then return "error: not found" end',
        'part.Transparency = 0.75',
        'part.Anchored = false',
        `part.CollisionGroup = ${JSON.stringify(customGroup)}`,
        'return "ok"',
      ].join('\n'));
      expect(mutated.trim()).toBe('ok');
      const dirty = await inspectInstance(gateway, path);
      expect(dirty?.Transparency).toBe(0.75);
      expect(dirty?.Anchored).toBe(false);
      expect(dirty?.CollisionGroup).toBe(customGroup);

      // 4. Preview must be clean (the properties still match what the turn wrote).
      const previewed = await previewRestore(gateway, store, checkpoint.id);
      expect(previewed.ok).toBe(true);
      if (previewed.ok) {
        expect(previewed.preview.clean).toBe(true);
        expect(previewed.preview.steps[0]?.action).toBe('restore-properties');
      }

      // 5. Restore, which re-inspects and verifies internally — no fake success.
      const restored = await applyRestore(gateway, store, checkpoint.id);
      expect(restored.ok).toBe(true);
      if (!restored.ok) return;
      expect(restored.result.failed).toEqual([]);
      expect(restored.result.status).toBe('restored');

      // 6. Studio itself must hold the old values again — including the STRING property.
      const after = await inspectInstance(gateway, path);
      expect(after?.Transparency).toBe(0);
      expect(after?.Anchored).toBe(true);
      expect(after?.CollisionGroup).toBe('Default');

      // 7. The keys no build can write are dropped at CAPTURE, so a clean restore reports NO skips.
      // Measured live before that: every undo listed UniqueId/Capabilities/ExplorerIconContent as
      // "skipped", which makes the report noise the user learns to ignore.
      expect(preState.entries[0]?.kind === 'properties' && preState.entries[0].properties.UniqueId).toBeUndefined();
      expect(restored.result.skipped).toEqual([]);
      expect(store.get(checkpoint.id)?.status).toBe('restored');
    } finally {
      const cleaned = await deleteInstance(gateway, path).catch((error) => {
        console.error('cleanup failed for', path, error instanceof Error ? error.message : error);
        return false;
      });
      expect(cleaned, 'the probe part must be removed from the place').toBe(true);
      expect(await exists(), 'the probe part must be gone after cleanup').toBe(false);
      expect(await inspectInstance(gateway, path)).toBeNull();
      live.close();
    }
  }, 90000);

  const tripleOf = (value: unknown): number[] =>
    String(value ?? '').split(',').map((part) => Number(part.trim()));
  /** Studio serialises floats at float32 precision, so an exact equality would fail on 0.2. */
  const expectTriple = (value: unknown, expected: number[]): void => {
    const actual = tripleOf(value);
    expect(actual).toHaveLength(expected.length);
    // Roblox quantises Color3 to 8-bit, so 0.1 comes back as 25/255 = 0.0980392.
    expected.forEach((want, index) => expect(actual[index]).toBeCloseTo(want, 2));
  };

  it('reconstructs Vector3/Color from the lossy inspect string and restores them', async () => {
    const { gateway, live } = await liveGateway();
    const db = createTestDb();
    db.prepare('INSERT INTO projects (id, name, created_at, last_active) VALUES (?, ?, ?, ?)').run('p1', 'P', 1, 1);
    db.prepare('INSERT INTO sessions (id, project_id, created_at, last_updated) VALUES (?, ?, ?, ?)').run('s1', 'p1', 1, 1);
    const store = new CheckpointStore(db);
    const name = `MorphiProbe${probeId()}`;
    const path = `Workspace.${name}`;

    const luau = async (code: string): Promise<string> => String(await gateway.callTool('execute_luau', { code, datamodel_type: 'Edit' }));
    const exists = async (): Promise<boolean> =>
      (await luau(`return game:GetService("Workspace"):FindFirstChild(${JSON.stringify(name)}) == nil and "missing" or "exists"`)).trim() === 'exists';

    try {
      // 1. A Part with a Vector3 Size and an exact Color (BrickColor is the legacy mirror and is
      // deliberately left out of the snapshot: writing it would override this exact colour).
      const created = await luau([
        'local part = Instance.new("Part")',
        `part.Name = ${JSON.stringify(name)}`,
        'part.Size = Vector3.new(4, 2, 1)',
        'part.Color = Color3.new(1, 0.2, 0.1)',
        'part.Parent = game:GetService("Workspace")',
        'return "ok"',
      ].join('\n'));
      expect(created.trim()).toBe('ok');

      // 2. The snapshot stores the lossy serialisation (Size as "4, 2, 1", Color as a triple).
      const preState = await snapshotPreState(gateway, 'studio.set_property', { path });
      const entry = preState.entries.find((e) => e.kind === 'properties');
      expect(entry?.kind).toBe('properties');
      if (entry?.kind !== 'properties') return;
      expect(entry.properties.Size).toBe('4, 2, 1');
      // Float formatting is Studio's, so compare the numbers, not the text.
      expectTriple(entry.properties.Color, [1, 0.2, 0.1]);
      expect(entry.properties.BrickColor).toBeUndefined();

      const checkpoint = store.record({
        sessionId: 's1',
        label: 'live vector/color edit',
        manifest: {
          tool: 'studio.set_property',
          callId: 'live-vec-call',
          argsHash: 'h',
          targets: [path],
          outcome: 'ok',
          preState,
          restorable: true,
          restoreReason: 'ok',
        },
      });

      // 3. Mutate both via Luau so the restore is proven non-trivial.
      const mutated = await luau([
        `local part = game:GetService("Workspace"):FindFirstChild(${JSON.stringify(name)})`,
        'if part == nil then return "error: not found" end',
        'part.Size = Vector3.new(8, 8, 8)',
        'part.Color = Color3.new(0.1, 0.2, 1)',
        'return "ok"',
      ].join('\n'));
      expect(mutated.trim()).toBe('ok');
      const dirty = await inspectInstance(gateway, path);
      expect(dirty?.Size).toBe('8, 8, 8');
      expectTriple(dirty?.Color, [0.1, 0.2, 1]);

      // 4. Restore re-applies the reconstructed literals (Vector3.new / Color3 fallback).
      const restored = await applyRestore(gateway, store, checkpoint.id);
      expect(restored.ok).toBe(true);
      if (!restored.ok) return;
      expect(restored.result.status).toBe('restored');

      // 5. Studio itself must hold the OLD Size and Color again — the reconstruction worked.
      const after = await inspectInstance(gateway, path);
      expect(after?.Size).toBe('4, 2, 1');
      expectTriple(after?.Color, [1, 0.2, 0.1]);
      expect(store.get(checkpoint.id)?.status).toBe('restored');
    } finally {
      const cleaned = await deleteInstance(gateway, path).catch((error) => {
        console.error('cleanup failed for', path, error instanceof Error ? error.message : error);
        return false;
      });
      expect(cleaned, 'the probe part must be removed from the place').toBe(true);
      expect(await exists(), 'the probe part must be gone after cleanup').toBe(false);
      expect(await inspectInstance(gateway, path)).toBeNull();
      live.close();
    }
  }, 90000);
});

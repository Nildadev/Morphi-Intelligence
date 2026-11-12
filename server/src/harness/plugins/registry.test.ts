import { describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../../../test/db';
import { createHarness, type Harness } from '../harness';
import { LlmRegistry } from '../llm/registry';
import { createProviderSettingsStore } from '../llm/settings';
import type { McpGateway } from '../tools/types';
import { BUILTIN_PLUGINS, toolsPlugin } from './index';
import { PluginDisposalError, PluginRegistry, type HarnessContext, type HarnessPlugin } from './registry';

const context: HarnessContext = { harness: {} as Harness };

function fakePlugin(id: string, calls: string[]): HarnessPlugin {
  return {
    id,
    version: '1.0.0',
    setup() {
      calls.push(`setup:${id}`);
    },
    dispose() {
      calls.push(`dispose:${id}`);
    },
  };
}

function stubMcp(): McpGateway {
  return {
    connected: false,
    studioLinked: false,
    server: { source: 'none', path: null, version: null },
    studio: null,
    toolCount: 0,
    lastError: null,
    listTools: async () => [],
    callTool: async () => undefined,
    reconnect: async () => undefined,
    // Task 31 shutdown contract: the test stub has nothing to release.
    close: async () => undefined,
  };
}

describe('PluginRegistry', () => {
  it('sets up in registration order and disposes in reverse registration order', async () => {
    const calls: string[] = [];
    const registry = new PluginRegistry([fakePlugin('first', calls), fakePlugin('second', calls)]);

    await registry.setupAll(context);

    expect(calls).toEqual(['setup:first', 'setup:second']);

    await registry.disposeAll();

    expect(calls).toEqual(['setup:first', 'setup:second', 'dispose:second', 'dispose:first']);
  });

  it('awaits each asynchronous setup before starting the next plugin', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const first: HarnessPlugin = {
      id: 'first',
      version: '1.0.0',
      async setup() {
        calls.push('first:start');
        await gate;
        calls.push('first:end');
      },
    };
    const second: HarnessPlugin = {
      id: 'second',
      version: '1.0.0',
      async setup() {
        calls.push('second');
      },
    };
    const registry = new PluginRegistry([first, second]);

    const pending = registry.setupAll(context);
    expect(calls).toEqual(['first:start']);

    release();
    await pending;

    expect(calls).toEqual(['first:start', 'first:end', 'second']);
  });

  it('stops setup at the first failure and surfaces that error unchanged', async () => {
    const calls: string[] = [];
    const failure = new Error('setup exploded');
    const broken: HarnessPlugin = {
      id: 'broken',
      version: '1.0.0',
      setup() {
        calls.push('setup:broken');
        throw failure;
      },
      dispose() {
        calls.push('dispose:broken');
      },
    };
    const registry = new PluginRegistry([fakePlugin('first', calls), broken, fakePlugin('last', calls)]);

    await expect(registry.setupAll(context)).rejects.toBe(failure);
    expect(calls).toEqual(['setup:first', 'setup:broken']);

    await registry.disposeAll();

    expect(calls).toEqual(['setup:first', 'setup:broken', 'dispose:broken', 'dispose:first']);
    expect(calls).not.toContain('setup:last');
    expect(calls).not.toContain('dispose:last');
  });

  it('registers each id once and keeps the first registration', async () => {
    const calls: string[] = [];
    const registry = new PluginRegistry();
    const first = fakePlugin('first', calls);

    registry.register(first);
    registry.register(fakePlugin('second', calls));
    registry.register(first);
    registry.register(fakePlugin('first', calls));

    expect(registry.list().map((plugin) => plugin.id)).toEqual(['first', 'second']);

    await registry.setupAll(context);
    await registry.disposeAll();

    expect(calls).toEqual(['setup:first', 'setup:second', 'dispose:second', 'dispose:first']);
  });

  it('keeps disposing after a failure and reports every failure together', async () => {
    const calls: string[] = [];
    const firstError = new Error('first down');
    const thirdError = new Error('third down');
    const registry = new PluginRegistry([
      {
        id: 'first',
        version: '1.0.0',
        setup() {
          return undefined;
        },
        dispose() {
          calls.push('dispose:first');
          throw firstError;
        },
      },
      {
        id: 'second',
        version: '1.0.0',
        setup() {
          return undefined;
        },
        dispose() {
          calls.push('dispose:second');
        },
      },
      {
        id: 'third',
        version: '1.0.0',
        setup() {
          return undefined;
        },
        dispose() {
          calls.push('dispose:third');
          throw thirdError;
        },
      },
    ]);

    await registry.setupAll(context);
    const error: unknown = await registry.disposeAll().then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(calls).toEqual(['dispose:third', 'dispose:second', 'dispose:first']);
    expect(error).toBeInstanceOf(PluginDisposalError);
    const report = error as PluginDisposalError;
    expect(report.failures.map((failure) => failure.id)).toEqual(['third', 'first']);
    expect(report.failures.map((failure) => failure.error)).toEqual([thirdError, firstError]);
    expect(report.message).toContain('third down');
    expect(report.message).toContain('first down');
  });

  it('disposes every registered plugin in reverse order even before setup runs', async () => {
    const calls: string[] = [];
    const registry = new PluginRegistry([fakePlugin('first', calls), fakePlugin('second', calls)]);

    await registry.disposeAll();

    expect(calls).toEqual(['dispose:second', 'dispose:first']);
  });

  it('disposes each plugin exactly once when disposeAll is called twice', async () => {
    const calls: string[] = [];
    const registry = new PluginRegistry([fakePlugin('first', calls), fakePlugin('second', calls)]);

    await registry.setupAll(context);
    await registry.disposeAll();
    await registry.disposeAll();

    expect(calls.filter((call) => call.startsWith('dispose:'))).toEqual(['dispose:second', 'dispose:first']);
  });

  it('runs setup once when setupAll is called twice and replays the same failure', async () => {
    const calls: string[] = [];
    const failure = new Error('setup exploded');
    const registry = new PluginRegistry([
      fakePlugin('first', calls),
      {
        id: 'broken',
        version: '1.0.0',
        setup() {
          calls.push('setup:broken');
          throw failure;
        },
      },
    ]);

    const first = await registry.setupAll(context).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    const second = await registry.setupAll(context).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(first).toBe(failure);
    expect(second).toBe(failure);
    expect(calls).toEqual(['setup:first', 'setup:broken']);
  });

  it('does not set up any plugin after disposeAll has completed', async () => {
    const calls: string[] = [];
    const registry = new PluginRegistry([fakePlugin('first', calls), fakePlugin('second', calls)]);

    await registry.disposeAll();
    calls.length = 0;

    await expect(registry.setupAll(context)).resolves.toBeUndefined();

    expect(calls).toEqual([]);
  });
});

describe('built-in plugins', () => {
  it('keeps the fixed order starting with tools and registers only that entry', () => {
    expect(BUILTIN_PLUGINS.map((plugin) => plugin.id)).toEqual(['tools']);
    expect(BUILTIN_PLUGINS[0]).toBe(toolsPlugin);
    expect(toolsPlugin.version).toBe('1.1.0');
  });

  it('wires the registry into the harness and disposes it during shutdown', async () => {
    const db = createTestDb();
    try {
      const harness = createHarness({
        db,
        llm: new LlmRegistry([]),
        mcp: stubMcp(),
        titleModel: 'auto',
        providerSettings: createProviderSettingsStore(db),
        compaction: { pruneAt: 0.7, summarizeAt: 0.85, keepRecentTurns: 6 },
      });
      expect(harness.plugins).toBeInstanceOf(PluginRegistry);
      expect(harness.plugins.list().map((plugin) => plugin.id)).toEqual(['tools']);

      const dispose = vi.spyOn(harness.plugins, 'disposeAll');
      await harness.dispose();
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });
});

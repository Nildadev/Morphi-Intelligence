import type { Harness } from '../harness';

export interface HarnessContext {
  harness: Harness;
}

export interface HarnessPlugin {
  id: string;
  version: string;
  setup(ctx: HarnessContext): Promise<void> | void;
  dispose?(): Promise<void> | void;
}

export interface PluginDisposalFailure {
  id: string;
  error: unknown;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Raised after `disposeAll()` has attempted every live plugin, so one failure cannot hide the rest. */
export class PluginDisposalError extends Error {
  readonly failures: readonly PluginDisposalFailure[];

  constructor(failures: PluginDisposalFailure[]) {
    super(`Plugin disposal failed: ${failures.map(({ id, error }) => `${id}: ${messageOf(error)}`).join('; ')}`);
    this.name = 'PluginDisposalError';
    this.failures = failures;
  }
}

/**
 * Fixed-order built-in plugin registry. 1.1.0 never loads external plugins.
 *
 * Setup and disposal are one-shot: `setupAll()` shares a single run between callers, and
 * `disposeAll()` unwinds that same set once. A partially failed setup only exposes the plugins
 * whose setup was attempted to disposal, so an unstarted plugin is never torn down.
 */
export class PluginRegistry {
  private readonly plugins: HarnessPlugin[] = [];
  private readonly attempted = new Set<string>();
  private setupTask: Promise<void> | null = null;
  private disposed = false;

  constructor(plugins: readonly HarnessPlugin[] = []) {
    for (const plugin of plugins) this.register(plugin);
  }

  /** Registration is idempotent per id: the first plugin with an id wins and order is stable. */
  register(plugin: HarnessPlugin): void {
    if (this.plugins.some((entry) => entry.id === plugin.id)) return;
    this.plugins.push(plugin);
  }

  /** Snapshot of the registered plugins in registration order. */
  list(): readonly HarnessPlugin[] {
    return [...this.plugins];
  }

  /**
   * Run every plugin's `setup` in registration order. The first failure stops later plugins and
   * is rethrown unchanged; `disposeAll()` can still unwind the successfully started prefix.
   * Disposal is terminal: a call after `disposeAll()` is a no-op.
   */
  setupAll(ctx: HarnessContext): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!this.setupTask) this.setupTask = this.runSetup(ctx);
    return this.setupTask;
  }

  private async runSetup(ctx: HarnessContext): Promise<void> {
    for (const plugin of [...this.plugins]) {
      this.attempted.add(plugin.id);
      await plugin.setup(ctx);
    }
  }

  /**
   * Tear down in reverse registration order. Every live plugin's `dispose` is attempted even
   * when an earlier one throws; the failures are collected and reported together afterwards.
   */
  async disposeAll(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    if (this.setupTask) {
      try {
        await this.setupTask;
      } catch {
        // The setupAll() caller already received this error; disposal still unwinds the prefix.
      }
    }

    const live = this.attempted.size === 0 ? [...this.plugins] : this.plugins.filter((plugin) => this.attempted.has(plugin.id));
    const failures: PluginDisposalFailure[] = [];
    for (const plugin of live.reverse()) {
      try {
        await plugin.dispose?.();
      } catch (error) {
        failures.push({ id: plugin.id, error });
      }
    }

    if (failures.length > 0) throw new PluginDisposalError(failures);
  }
}

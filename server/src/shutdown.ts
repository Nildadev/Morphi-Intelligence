/**
 * Orderly quit for the packaged app.
 *
 * Task 32 requires four things to happen on the way out, and each of them has bitten a build:
 *
 * 1. live turns are aborted FIRST, because a running turn keeps an SSE response open and
 *    `server.close()` waits for every connection it handed out;
 * 2. the Studio MCP child is closed, otherwise quitting leaves an orphaned process holding the pipe;
 * 3. registered plugins are disposed (their registrations are what hold timers and listeners);
 * 4. the SQLite handle is closed LAST, after nothing can write any more — a WAL left behind is
 *    recoverable, a `close()` followed by a write is a crash.
 *
 * A step that throws is logged and skipped: one broken dependency must not strand the process (the
 * timeout is the backstop, but a dispose() that throws would otherwise skip the close that follows).
 * Every call after the first is a no-op, since `before-quit` and a signal can both fire.
 */

export interface ShutdownDeps {
  /** Abort every in-flight turn (they hold the SSE responses `server.close()` waits for). */
  abortTurns: () => void;
  /** Stop the Studio MCP child process and its pipe. */
  closeMcp: () => Promise<void>;
  /** Dispose plugin registrations (timers, listeners) in reverse registration order. */
  disposeHarness: () => Promise<void>;
  /** Stop accepting connections; `onClosed` runs once every open one is gone. */
  closeServer: (onClosed: () => void) => void;
  /** Close the durable handle exactly once. */
  closeDb: () => void;
  exit: (code: number) => void;
  /** Backstop when `closeServer` never reports closure (a stuck SSE keeps it open forever). */
  timeoutMs?: number;
  log?: (line: string) => void;
}

export const SHUTDOWN_TIMEOUT_MS = 1500;

export function createShutdown(deps: ShutdownDeps): () => Promise<void> {
  let running: Promise<void> | null = null;
  let dbClosed = false;

  const closeDbOnce = (): void => {
    if (dbClosed) return;
    dbClosed = true;
    try {
      deps.closeDb();
    } catch (error) {
      deps.log?.(`shutdown: closing the database failed: ${messageOf(error)}`);
    }
  };

  const finish = (): void => {
    closeDbOnce();
    deps.exit(0);
  };

  const attempt = async (label: string, run: () => void | Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      deps.log?.(`shutdown: ${label} failed: ${messageOf(error)}`);
    }
  };

  return () => {
    if (running !== null) return running;
    running = (async () => {
      // Aborting is synchronous and cannot fail meaningfully, but it is still wrapped: a throw here
      // would skip the MCP close and the DB close that are the whole point of this path.
      await attempt('aborting live turns', deps.abortTurns);
      await attempt('closing the Studio MCP child', deps.closeMcp);
      await attempt('disposing plugins', deps.disposeHarness);

      let closed = false;
      const onClosed = (): void => {
        if (closed) return;
        closed = true;
        finish();
      };
      try {
        deps.closeServer(onClosed);
      } catch (error) {
        deps.log?.(`shutdown: closing the server failed: ${messageOf(error)}`);
        onClosed();
        return;
      }
      // The timer is the backstop, not the plan: a live turn that never releases its response keeps
      // `server.close()` from calling back. Quitting late is what makes a quit look like a hang.
      const timer = setTimeout(onClosed, deps.timeoutMs ?? SHUTDOWN_TIMEOUT_MS);
      // Node's timer keeps the loop alive; the process is on its way out and must not wait for it.
      (timer as { unref?: () => void }).unref?.();
    })();
    return running;
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

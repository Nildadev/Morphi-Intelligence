export class CancellationRegistry {
  private active = new Map<string, AbortController>();

  start(key: string): AbortController {
    const controller = new AbortController();
    this.active.set(key, controller);
    return controller;
  }

  has(key: string): boolean {
    return this.active.has(key);
  }

  cancel(key: string): boolean {
    const controller = this.active.get(key);
    if (!controller) return false;
    controller.abort();
    // Release the key as well as aborting: `busy()` is built on `has()`, and the session-delete and
    // memory-clear paths cancel a turn they are about to orphan, so an entry left here would keep
    // that id reporting itself busy forever. The signal is what stops the work, not the map entry.
    this.active.delete(key);
    return true;
  }

  finish(key: string, controller: AbortController): void {
    if (this.active.get(key) === controller) this.active.delete(key);
  }
}

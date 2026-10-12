export type ProjectRunQueue = {
  enqueue(runId: string): void;
  idle(): Promise<void>;
};

export function createProjectRunQueue(
  perform: (runId: string) => Promise<void>,
  onError: (runId: string, error: unknown) => void = () => {},
): ProjectRunQueue {
  const pending: string[] = [];
  const known = new Set<string>();
  const idleWaiters: (() => void)[] = [];
  let running = false;

  function resolveIdle(): void {
    if (running || pending.length > 0) return;
    for (const resolve of idleWaiters.splice(0)) resolve();
  }

  async function drain(): Promise<void> {
    if (running) return;
    running = true;
    while (pending.length > 0) {
      const runId = pending.shift()!;
      try {
        await perform(runId);
      } catch (error) {
        onError(runId, error);
      } finally {
        known.delete(runId);
      }
    }
    running = false;
    resolveIdle();
  }

  return {
    enqueue(runId) {
      if (known.has(runId)) return;
      known.add(runId);
      pending.push(runId);
      void drain();
    },
    idle() {
      if (!running && pending.length === 0) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.push(resolve));
    },
  };
}

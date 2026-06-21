// Write-back batch buffer. POST /search increments an in-memory map and returns
// immediately; the buffer flushes to Postgres on size (batchSize) OR interval
// (flushIntervalMs). A crash loses at most one un-flushed window — acceptable
// for approximate, self-healing counts (see DESIGN.md).
import { config } from './config';
import { counters } from './metrics';

export type FlushHandler = (window: Map<string, number>) => Promise<void>;

export class WriteBuffer {
  private buffer = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  constructor(private readonly onFlush: FlushHandler) {}

  add(rawQuery: string): void {
    const query = rawQuery.toLowerCase().trim();
    if (!query) return;
    counters.searchesReceived++;
    this.buffer.set(query, (this.buffer.get(query) || 0) + 1);
    if (this.buffer.size >= config.batchSize) void this.flush();
  }

  async flush(): Promise<void> {
    if (this.flushing || this.buffer.size === 0) return;
    this.flushing = true;
    const window = this.buffer; // swap out the current window...
    this.buffer = new Map(); // ...and start a fresh one (no await between)
    try {
      await this.onFlush(window);
    } catch (err) {
      // a transient flush error must not crash the process; the window is lost,
      // which is the same trade-off as the documented crash window
      console.error('[flush] error:', (err as Error).message);
    } finally {
      this.flushing = false;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), config.flushIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush(); // final drain
  }

  pending(): number {
    return this.buffer.size;
  }
}

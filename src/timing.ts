export interface TimingSummary {
  fps: number;
  meanMs: number;
  p95Ms: number;
  maxMs: number;
  cpuP95Ms: number;
  slowFrames: number;
}

/** Actual callback intervals, independent of the browser's ideal rAF timestamps. */
export class FrameTiming {
  private readonly intervals: Float64Array;
  private readonly work: Float64Array;
  private previous: number | null = null;
  private count = 0;
  private index = 0;
  constructor(private readonly capacity = 120) {
    this.intervals = new Float64Array(capacity); this.work = new Float64Array(capacity);
  }
  reset() { this.previous = null; this.count = 0; this.index = 0; }
  record(start: number, workMs: number) {
    if (this.previous !== null) {
      this.intervals[this.index] = Math.max(0, start - this.previous);
      this.work[this.index] = Math.max(0, workMs);
      this.index = (this.index + 1) % this.capacity; this.count = Math.min(this.count + 1, this.capacity);
    }
    this.previous = start;
  }
  summary(): TimingSummary {
    if (!this.count) return { fps: 0, meanMs: 0, p95Ms: 0, maxMs: 0, cpuP95Ms: 0, slowFrames: 0 };
    const intervals = Array.from(this.intervals.subarray(0, this.count)).sort((a, b) => a - b);
    const work = Array.from(this.work.subarray(0, this.count)).sort((a, b) => a - b);
    const meanMs = intervals.reduce((sum, ms) => sum + ms, 0) / this.count;
    const median = intervals[Math.floor((this.count - 1) / 2)];
    return {
      fps: meanMs ? 1000 / meanMs : 0, meanMs,
      p95Ms: intervals[Math.ceil(this.count * 0.95) - 1], maxMs: intervals[this.count - 1],
      cpuP95Ms: work[Math.ceil(this.count * 0.95) - 1],
      slowFrames: intervals.filter(ms => ms > Math.max(8, median * 1.5)).length,
    };
  }
}

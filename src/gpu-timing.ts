export interface GpuTimingSummary { supported: boolean; p95Ms: number | null; maxMs: number | null; pending: number }
interface TimerQueryExtension { readonly TIME_ELAPSED_EXT: number; readonly GPU_DISJOINT_EXT: number }

/** Queries are read only after a later frame reports availability; never waits for GL. */
export class GpuTiming {
  private readonly extension: TimerQueryExtension | null;
  private readonly pending: WebGLQuery[] = [];
  private readonly free: WebGLQuery[] = [];
  private readonly values = new Float64Array(120);
  private active: WebGLQuery | null = null;
  private cursor = 0;
  private count = 0;
  private frame = 0;
  constructor(private readonly gl: WebGL2RenderingContext) {
    this.extension = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  }
  begin() {
    if (!this.extension) return;
    if (this.gl.getParameter(this.extension.GPU_DISJOINT_EXT)) {
      this.count = 0; this.cursor = 0;
      while (this.pending.length) this.free.push(this.pending.shift()!);
    }
    while (this.pending.length && this.gl.getQueryParameter(this.pending[0], this.gl.QUERY_RESULT_AVAILABLE)) {
      const query = this.pending.shift()!;
      this.values[this.cursor] = this.gl.getQueryParameter(query, this.gl.QUERY_RESULT) / 1e6;
      this.cursor = (this.cursor + 1) % this.values.length;
      this.count = Math.min(this.count + 1, this.values.length); this.free.push(query);
    }
    // One measurement every fourth frame; bound GPU query storage if results lag.
    if (this.frame++ % 4 || this.pending.length >= 8) return;
    this.active = this.free.pop() ?? this.gl.createQuery();
    if (this.active) this.gl.beginQuery(this.extension.TIME_ELAPSED_EXT, this.active);
  }
  end() {
    if (!this.active || !this.extension) return;
    this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);
    this.pending.push(this.active); this.active = null;
  }
  summary(): GpuTimingSummary {
    const values = Array.from(this.values.subarray(0, this.count)).sort((a,b) => a-b);
    return { supported: !!this.extension, p95Ms: this.count ? values[Math.ceil(this.count * 0.95) - 1] : null, maxMs: this.count ? values[this.count - 1] : null, pending: this.pending.length };
  }
  dispose() {
    this.end();
    for (const query of [...this.pending, ...this.free]) this.gl.deleteQuery(query);
    this.pending.length = 0; this.free.length = 0;
  }
}

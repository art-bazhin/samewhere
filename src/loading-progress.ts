/** Completed work units, with fractional progress only when it is measurable. */
export class LoadingProgress {
  private readonly tasks: { weight: number; value: number }[] = [];
  private sealed = false;
  constructor(private readonly update: (value: number) => void) {}
  task(weight = 1) {
    if (this.sealed) throw new Error('Loading tasks must be registered before loading starts');
    const task = { weight, value: 0 }; this.tasks.push(task);
    return (value = 1) => { task.value = Math.max(task.value, Math.min(1, Math.max(0, value))); this.report(); };
  }
  seal() { this.sealed = true; this.report(); }
  private report() {
    if (!this.sealed) return;
    const total = this.tasks.reduce((sum, task) => sum + task.weight, 0);
    this.update(total ? this.tasks.reduce((sum, task) => sum + task.weight * task.value, 0) / total : 1);
  }
}

export async function fetchLoadingBuffer(url: string, signal: AbortSignal, update?: (value?: number) => void) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Download failed: ${response.status} (${url})`);
  const length = Number(response.headers.get('content-length')), encoding = response.headers.get('content-encoding');
  // Streams expose decoded bytes, while Content-Length may describe compressed
  // bytes. Without a usable total, report completion rather than inventing one.
  if (!update || !response.body || !length || encoding && encoding !== 'identity') {
    const buffer = await response.arrayBuffer(); update?.(); return buffer;
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); received += value.byteLength; update(Math.min(received / length, .999));
  }
  const bytes = new Uint8Array(received); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  update(); return bytes.buffer;
}

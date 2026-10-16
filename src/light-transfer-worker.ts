import { decodeTransferAsset } from './light-transfer-asset';
import type { PreparedTransfer } from './light-transfer-cache';

export interface TransferRequest { url: string; sourceHash: string }
export type TransferResult = { elapsedMs: number; fields: PreparedTransfer[] } | { error: string };
const scope = self as unknown as { onmessage: (event: MessageEvent<TransferRequest>) => Promise<void>; postMessage: (data: TransferResult, transfer?: Transferable[]) => void };
scope.onmessage = async ({ data }) => {
  try {
    const start = performance.now(), response = await fetch(data.url);
    if (!response.ok || !response.body) throw new Error(`Cannot load prepared lighting: HTTP ${response.status}`);
    // Some hosts (including Vite) serve .gz as Content-Encoding: gzip, which
    // fetch already decompresses. Others return the compressed file verbatim.
    const decodedByBrowser = response.headers.get('content-encoding')?.split(',').some(encoding => encoding.trim().toLowerCase() === 'gzip');
    const body = decodedByBrowser ? response.body : response.body.pipeThrough(new DecompressionStream('gzip'));
    const buffer = await new Response(body).arrayBuffer();
    const fields = decodeTransferAsset(buffer, data.sourceHash);
    // Every typed array is a view into this single buffer: transfer it once.
    scope.postMessage({ elapsedMs: performance.now() - start, fields }, [buffer]);
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};

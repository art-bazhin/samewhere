import { bakeLightTransfer, type BakedLighting } from './light-transfer-bake';

export type TransferResult = BakedLighting | { error: string };
const scope = self as unknown as { onmessage: () => void; postMessage: (data: TransferResult, transfer?: Transferable[]) => void };
scope.onmessage = () => {
  try {
    const result = bakeLightTransfer();
    scope.postMessage(result, [...result.fields.flatMap(field => [field.runs.buffer as ArrayBuffer, field.values.buffer as ArrayBuffer]),
      ...Object.values(result.panels).map(values => values.buffer as ArrayBuffer)]);
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};

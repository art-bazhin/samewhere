import type { AnalyticsSink } from './run-analytics';

export type AnalyticsCommand = (command: string, ...args: unknown[]) => void;
export interface AnalyticsConfig { enabled: boolean; gameKey: string; secretKey: string; build: string }

// SDK 5.0.0's ESM default is its command API; its declarations incorrectly describe a class.
const loadSdk = async () => (await import('gameanalytics')).default as unknown as AnalyticsCommand;

/** Import on first use, then wait for SDK session initialization before draining events. */
export function createGameAnalyticsSink(config: AnalyticsConfig, load: () => Promise<AnalyticsCommand> = loadSdk): AnalyticsSink {
  let disabled = !config.enabled || !/^[a-z\d]{32}$/i.test(config.gameKey) || !/^[a-z\d]{40}$/i.test(config.secretKey);
  let loading = false, ready = false;
  let command: AnalyticsCommand;
  const pending: [string, number][] = [];
  const flush = () => {
    if (!ready || disabled) return;
    try { for (const [event, value] of pending.splice(0)) command('addDesignEvent', event, value); }
    catch { disabled = true; pending.length = 0; }
  };
  return (event, value) => {
    if (disabled) return;
    // Bound memory while the SDK downloads or its initialization request is blocked.
    if (pending.length < 128) pending.push([event, value]);
    if (ready) { flush(); return; }
    if (loading) return;
    loading = true;
    void Promise.resolve().then(load).then(sdk => {
      command = sdk;
      const listener = { onRemoteConfigsUpdated() {
        try { ready = true; command('removeRemoteConfigsListener', listener); flush(); }
        catch { disabled = true; pending.length = 0; }
      } };
      command('setEnabledInfoLog', false); command('setEnabledVerboseLog', false);
      command('enableHealthEvent', false);
      command('configureBuild', (config.build || 'local').slice(0, 32));
      command('addRemoteConfigsListener', listener);
      command('initialize', config.gameKey, config.secretKey);
    }).catch(() => { disabled = true; pending.length = 0; });
  };
}

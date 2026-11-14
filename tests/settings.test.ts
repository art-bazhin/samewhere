import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSettings, saveSettings, SETTINGS_KEY } from '../src/settings';

test('look sensitivity persists independently at its default and both range limits', () => {
  const entries = new Map([['samewhere.save', 'existing game']]);
  const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); } };
  assert.deepEqual(loadSettings(storage), { lookSensitivity: 1 });
  for (const lookSensitivity of [.2, 1, 4]) {
    saveSettings({ lookSensitivity }, storage);
    assert.deepEqual(loadSettings(storage), { lookSensitivity });
    assert.equal(storage.getItem('samewhere.save'), 'existing game');
  }
  entries.delete('samewhere.save');
  saveSettings({ lookSensitivity: 2 }, storage);
  assert.equal(storage.getItem('samewhere.save'), null);
  assert.equal(loadSettings(storage).lookSensitivity, 2);
});

test('invalid settings and unavailable storage use safe defaults without interrupting play', () => {
  for (const json of ['{', 'null', '{}', '{"lookSensitivity":"2"}', '{"lookSensitivity":0}', '{"lookSensitivity":-1}',
    '{"lookSensitivity":0.01}', '{"lookSensitivity":0.19}', '{"lookSensitivity":4.1}', '{"lookSensitivity":99}', '{"lookSensitivity":null}']) {
    assert.equal(loadSettings({ getItem: () => json }).lookSensitivity, 1);
  }
  const blocked = { getItem(): string | null { throw new Error('Blocked'); }, setItem() { throw new Error('Quota exceeded'); } };
  assert.equal(loadSettings(blocked).lookSensitivity, 1);
  assert.doesNotThrow(() => saveSettings({ lookSensitivity: 2 }, blocked));
  assert.equal(SETTINGS_KEY, 'samewhere.settings');
});

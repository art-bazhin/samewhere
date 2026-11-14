export const SETTINGS_KEY = 'samewhere.settings';
export interface Settings { lookSensitivity: number }

export function loadSettings(storage?: Pick<Storage, 'getItem'>): Settings {
  const settings = { lookSensitivity: 1 };
  try {
    const value = JSON.parse((storage ?? localStorage).getItem(SETTINGS_KEY) ?? 'null')?.lookSensitivity;
    if (typeof value === 'number' && Number.isFinite(value) && value >= .2 && value <= 4) settings.lookSensitivity = Math.round(value * 10) / 10;
  } catch { /* Use defaults when settings are damaged or storage is unavailable. */ }
  return settings;
}

export function saveSettings(settings: Settings, storage?: Pick<Storage, 'setItem'>) {
  try { (storage ?? localStorage).setItem(SETTINGS_KEY, JSON.stringify(settings)); }
  catch { /* The current session can still use the chosen sensitivity. */ }
}

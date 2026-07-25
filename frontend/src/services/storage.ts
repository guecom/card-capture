import type { RuntimeConfig } from '../contracts/capture';

const PREFIX = 'cc_';

function read(key: string): string {
  try {
    return localStorage.getItem(`${PREFIX}${key}`) ?? '';
  } catch {
    return '';
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(`${PREFIX}${key}`, value);
  } catch {
    // The legacy app also treats unavailable local storage as non-fatal.
  }
}

export function loadRuntimeConfig(): RuntimeConfig {
  return {
    apiUrl: read('api'),
    token: read('token'),
    capturer: read('name'),
  };
}

export function saveRuntimeConfig(config: RuntimeConfig): void {
  write('api', config.apiUrl.trim());
  write('token', config.token.trim());
  write('name', config.capturer.trim());
}

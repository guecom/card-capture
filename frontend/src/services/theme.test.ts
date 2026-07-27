import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadThemePreference, saveThemePreference, signOutDevice } from './storage';
import { resolveTheme } from './theme';
import { FakeStorage } from './test-storage';

let store: FakeStorage;

beforeEach(() => {
  store = new FakeStorage();
  vi.stubGlobal('localStorage', store);
});

afterEach(() => vi.unstubAllGlobals());

describe('theme preference (INT-000016 항목 003)', () => {
  it('starts light on a new device, whatever the phone is set to', () => {
    expect(loadThemePreference()).toBe('light');
    expect(resolveTheme(loadThemePreference(), true)).toBe('light');
  });

  it('keeps a directly chosen theme instead of following the phone', () => {
    saveThemePreference('light');
    expect(resolveTheme(loadThemePreference(), true)).toBe('light');

    saveThemePreference('dark');
    expect(resolveTheme(loadThemePreference(), false)).toBe('dark');
  });

  it('follows the phone only when the user asked it to', () => {
    saveThemePreference('system');
    expect(resolveTheme(loadThemePreference(), true)).toBe('dark');
    expect(resolveTheme(loadThemePreference(), false)).toBe('light');
  });

  it('survives a reload and falls back to light on a damaged value', () => {
    saveThemePreference('dark');
    expect(loadThemePreference()).toBe('dark');

    store.setItem('cc_theme', 'neon');
    expect(loadThemePreference()).toBe('light');
  });

  // 테마는 사적 기록이 아니라 이 기기의 표시 설정이다 — 연결을 끊어도 눈에 맞춘 화면은 남는다.
  it('is not wiped by disconnecting the device', () => {
    saveThemePreference('dark');
    signOutDevice();
    expect(loadThemePreference()).toBe('dark');
  });
});

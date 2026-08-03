import { expect, test } from '@playwright/test';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';

const docs = fileURLToPath(new URL('../../docs/', import.meta.url));

test('APP-AC-240 retires every current legacy entry and bumps the cleanup cache', async () => {
  await expect(access(`${docs}legacy.html`, constants.F_OK)).rejects.toThrow();
  const index = await readFile(`${docs}index.html`, 'utf8');
  const rootSw = await readFile(`${docs}sw.js`, 'utf8');
  const frontend = await readFile(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
  const app = await readFile(fileURLToPath(new URL('../src/App.tsx', import.meta.url)), 'utf8');
  // 후보 앱(`next/`)의 진입 문서와 **생성된** service worker도 함께 본다. 이 둘을 빼면 은퇴가
  // 실제로 배포되는 표면에서 되살아나도 게이트가 통과한다 — 사용자가 여는 것은 `next/`다.
  // (`next/sw.js`는 vite.config.ts의 candidatePwa() 템플릿에서 생성되므로 그 회귀도 여기서 잡힌다.)
  const nextIndex = await readFile(`${docs}next/index.html`, 'utf8');
  const nextSw = await readFile(`${docs}next/sw.js`, 'utf8');
  const builtAssets = await Promise.all(
    [...nextIndex.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)]
      .map((match) => readFile(`${docs}next/${match[1].replace(/^\.\//, '')}`, 'utf8')),
  );
  expect([index, rootSw, frontend, app, nextIndex, nextSw, ...builtAssets].join('\n')).not.toContain('legacy.html');
  expect(rootSw).toContain("var CACHE = 'cardcapture-v21'");
  expect(rootSw).toContain("/^cardcapture-v/.test(k) && k !== CACHE");
});

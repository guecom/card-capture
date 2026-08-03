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
  const builtAssets = await readFile(`${docs}next/index.html`, 'utf8').then(async (nextIndex) => {
    const paths = [...nextIndex.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((match) => match[1]);
    return Promise.all(paths.map((assetPath) => readFile(`${docs}next/${assetPath.replace(/^\.\//, '')}`, 'utf8')));
  });
  expect([index, rootSw, frontend, app, ...builtAssets].join('\n')).not.toContain('legacy.html');
  expect(rootSw).toContain("var CACHE = 'cardcapture-v21'");
  expect(rootSw).toContain("/^cardcapture-v/.test(k) && k !== CACHE");
});

# React Ionic migration candidate

Kairen-Ref: `TSK-000221`

This directory owns the parallel React + TypeScript + Vite candidate. It does not replace `docs/index.html` until contract parity and the human merge/release gate pass.

## Ownership

- Ionic React owns the app shell, safe-area behavior, toolbar, sheet/modal and toast primitives.
- Tailwind is imported without Preflight and is used only inside `#kairen-ui` for Kairen-owned layout/content composition.
- Ionic internals are themed through CSS variables and component properties, not utility overrides of Shadow DOM.
- `src/services/` owns typed adapters for the existing GAS and IndexedDB contracts.
- a small build-time generator emits `docs/next/sw.js` for only the `/next/` scope, so it cannot replace the legacy root service worker or add Workbox dependency risk. `npm run test:e2e` starts the built shell, waits for candidate control, stops the origin server, and verifies that Chrome reloads the cached shell and navigation.
- Camera, OpenCV, Tesseract, upload writes and service-worker replacement remain on the legacy path until their contract gates exist.

## Build

```powershell
npm.cmd install
npm.cmd run validate
```

The Vite build writes only `docs/next/`. The public root `docs/index.html` remains the legacy rollback baseline.

## Migration gates

1. Typed contract and read-only shell.
2. List/search/detail parity against synthetic and existing server fixtures.
3. IndexedDB write/retry parity: reopen persistence, oldest-first send, terminal non-duplication and failed retry fixture implemented; browser offline/reconnect remains.
4. Camera/detector/OCR adapter parity on actual phones.
5. Exact candidate SHA review, then separate human merge and release decisions.

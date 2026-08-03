# React Ionic frontend

Kairen-Ref: `TSK-000221`

This directory owns the React + TypeScript + Vite production frontend. The root Pages entrypoint preserves query parameters and opens the built app under `docs/next/`; this rollback release restores the v2.19 user-facing behavior while retaining the current root and security boundary.

## Ownership

- Ionic React owns the app shell, safe-area behavior, toolbar, sheet/modal and toast primitives.
- Tailwind is imported without Preflight and is used only inside `#kairen-ui` for Kairen-owned layout/content composition.
- Ionic internals are themed through CSS variables and component properties, not utility overrides of Shadow DOM.
- `src/services/` owns typed adapters for the existing GAS and IndexedDB contracts.
- `src/services/camera.ts` owns environment-camera request, permission/failure mapping, stream cleanup, front/back capture, torch and native-camera fallback.
- a small build-time generator emits `docs/next/sw.js` for only the `/next/` scope. The root service worker ignores `/next/` and deletes only its own legacy cache prefix, so the two offline caches cannot erase each other.
- Camera, OpenCV, Tesseract, upload/retry, brief, profile and post-processing actions retain the legacy payload and authority contracts behind typed services.

## Build

```powershell
npm.cmd install
npm.cmd run validate
```

The Vite build writes only `docs/next/`. The public root `docs/index.html` is the query-preserving live entrypoint. The pinned API comes from `config/public-runtime.json`.

## Migration gates

1. Typed contract and shell.
2. List/search/detail and post-processing action parity.
3. IndexedDB write/retry, server-off reload and reconnect recovery.
4. Camera/detector/OCR parity while keeping the retired `legacy.html` entry point absent.
5. Exact SHA CI, human phone acceptance, merge and release evidence.

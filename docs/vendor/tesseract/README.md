# Vendored on-device OCR

Kairen-Ref: `TSK-000217`

These pinned browser assets keep business-card OCR on the user's device. No card image is sent to a third-party OCR service.

- `tesseract.js` 5.1.1 (`tesseract.min.js`, `worker.min.js`) — Apache-2.0
- `tesseract.js-core` 5.1.1 (`tesseract-core-simd-lstm.wasm.js`) — Apache-2.0
- `@tesseract.js-data/kor` 1.0.0, `4.0.0_best_int` — MIT package metadata / upstream Tesseract language data
- `@tesseract.js-data/eng` 1.0.0, `4.0.0_best_int` — MIT package metadata / upstream Tesseract language data

Source packages were downloaded from the npm registry with `npm pack` and only the runtime files required by the progressive OCR path were copied here. The SIMD LSTM core is the supported-path artifact for Android Chrome and iOS Safari 16+; unsupported engines fall back to manual name confirmation without blocking capture or upload.

## SHA-256

```text
tesseract.min.js a8e29918d098b2b06e1012bdaeffb4aec0445c5d5654709023e0bd1f442a80e8
worker.min.js aca1229639fc9907d86f96e825955a2b7c5716d17f3bc3acd71f9c7ab66181fc
tesseract-core-simd-lstm.wasm.js ce20eda9533cbed1e6c2b4276fbae1e0adc61b6754b5513084be601787b457cf
kor.traineddata.gz 78c21276ab14c9bb734d83be1055d9fe5469a4e7e977c51ad385be5737e61126
eng.traineddata.gz 45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91
```

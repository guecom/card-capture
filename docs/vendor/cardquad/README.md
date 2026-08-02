# Card quadrilateral model

This directory vendors the DocAligner LCNet100 heatmap-regression ONNX model for
on-device business-card corner proposals.

- Upstream: https://github.com/DocsaidLab/DocAligner
- Upstream revision reviewed: 3275b0f07f8e99d8c01cb0774dea2549be1416b6
- Model file: lcnet100_h_e_bifpn_256_fp32.onnx
- Model SHA-256: f4117b786e3a18470f3865c93f3c2bd69d9b998edd60f385574a5c665e79594e
- License: Apache License 2.0; see LICENSE in this directory

The browser runs the model locally through ONNX Runtime Web. Images and heatmaps
are not sent to the model provider or any remote inference API. OpenCV verifies
the proposal against live edges before the UI can display or auto-capture it.

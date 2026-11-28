# Performance and backend compatibility

The optimization path prioritizes NVIDIA CUDA, then usable AMD backends, with
CPU fallback on Windows and macOS. Backend availability is not proof that every
model operator is supported. This change does not enable new training backends
or change model precision, sampling steps, or audio segmentation.

## Current backend limits

- RVC training uses CUDA when available, otherwise CPU. DirectML/MPS training
  is not implemented.
- RVC inference already probes CUDA and then DirectML. DirectML additionally
  requires a compatible torch-directml installation, ONNX Runtime with the DML
  provider, and the RMVPE ONNX model. The automatic installer does not provision
  all of these dependencies. AMD GPU inference is therefore not guaranteed by
  automatic installation.
- SoulX automatically selects CUDA or CPU. macOS RVC/SoulX currently use CPU;
  MPS model compatibility has not been validated.
- CUDA Graph optimization is gated by the CUDA device and support probe.
  CPU, MPS, and DirectML calls take the normal execution path.

## Optimizations

- Training computes gradient norms only on rank-zero logging steps, transferring
  the norms together rather than synchronizing once per parameter. Gradients and
  optimizer update order are unchanged.
- SoulX retains conditioning for the most recently used reference audio. File
  path, modification/creation metadata, size, prompt duration, and device form
  the cache key. Returned tensors are cloned to isolate in-place inference.
- CUDA Graph capture waits for repeated input shapes. The first two calls use
  normal execution; the third captures. Pending shape history is bounded to
  four times the graph cache size. Capture failures retain eager fallback.

`RVC_CUDA_GRAPH_MIN_CALLS` controls admission (default `3`, `1` restores immediate
capture). `RVC_CUDA_GRAPH_MAX_CACHE` controls graph capacity (default `8`).
`RVC_CUDA_GRAPH=0` disables graphs. `get_cuda_graph_stats()` includes `deferred`
calls and `pending` shapes alongside captures, replays, fallbacks and evictions.

## Validation

Run `python -m unittest discover -s tests -v` in a Python environment with torch,
numpy and soundfile. Tests use real CPU tensors and mocked model/capture calls;
they do not require model weights. They cover gradient norms, clipping,
non-CUDA bypass, shape admission, capture failure, and prompt cache invalidation.

Before claiming a speedup, benchmark the same dataset/checkpoint and audio on
each target backend. Separate cold startup from warmed inference, report
training step time and peak memory, and compare generated audio. Real CUDA
capture/replay, full training, AMD and macOS execution need hardware validation.

# Third-Party Notices

This plugin bundles or downloads third-party software and model weights.
Review each license before redistribution.

## Bundled code

- **RVC** (`vendor/rvc`) — MIT License.
  Source: https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI
- **SoulX-Singer** (`vendor/soulx`) — Apache License 2.0.
  Source: https://github.com/Soul-AILab/SoulX-Singer

## Downloaded at setup (not bundled)

- **RMVPE / HuBERT base** — from `lj1995/VoiceConversionWebUI`; see the upstream repository for the model terms.
- **SoulX-Singer SVC model** (`model-svc.pt`) — Apache License 2.0; see
  https://huggingface.co/Soul-AILab/SoulX-Singer
- **Whisper base** — MIT License; OpenAI Whisper.
- **BS-Roformer separation model** — from the UVR / audio-separator ecosystem; check the original model card/license before commercial use.
- **audio-separator** — MIT License.
- **PyTorch** — BSD-style license.
- **transformers** — Apache License 2.0.
- **librosa** — ISC License.
- **soundfile** — BSD License.
- **faiss** — MIT License.
- **av** — BSD License.
- **praat-parselmouth** — MIT License (check upstream).
- **imageio-ffmpeg / ffmpeg** — ffmpeg is LGPL/GPL depending on build; imageio-ffmpeg is BSD-2-Clause.
- **TensorBoard** — Apache License 2.0.
- **scikit-learn** — BSD-3-Clause.
- **RVC pretrained v2 models** (`f0G48k.pth` / `f0D48k.pth`) — from `lj1995/VoiceConversionWebUI`; check the upstream model terms.

## Voice data and models

Voice models (`.pth`), profiles and prompt audio are supplied by the user.
Do not redistribute a voice without the rights holder's permission.

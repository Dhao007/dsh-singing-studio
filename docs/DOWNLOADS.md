# 环境下载地址总表

> 核对时间：2026-11-11。来源：`src/deps.js`、`src/store.js`、`engine/requirements-rvc.txt`、`engine/requirements-soulx.txt`、`engine/download.py`。
> 一键安装会按下列顺序自动尝试；下载失败时也可以照本表手动下载，放到「目标路径」后点「重新检查环境」。
> 目标路径按默认 **managed** 模式给出，根目录是 `~/.dsh/plugins-data/singing-studio/runtime/`。
> 范围只含「运行环境」：系统底座、Python 包、模型资源、插件本体。网易云搜歌（`music.163.com`）和用户自己上传 / 训练的数据不算环境，不在此表。

## 0. 速览

| 类别 | 内容 | 体积 | 是否必需 |
|---|---|---|---|
| 系统底座 | Python 3.10–3.12、Node ≥ 22.13、ffmpeg | — | 必需（项目不内置下载地址） |
| Python 包 | 3 个 venv、torch / torchaudio、音频与推理依赖 | 约 3–5 GB | 必需 |
| RVC 资源 | `rmvpe.pt` + `hubert_base`（3 个文件） | 约 371 MB | 必需 |
| RVC 训练底模 | `f0G48k.pth` + `f0D48k.pth` | 约 218 MB | 训练时必需 |
| SoulX | `model-svc.pt` | 约 2.79 GB | 必需 |
| Whisper base | `openai/whisper-base`（transformers 缓存） | 约 290 MB | 必需（SoulX 用） |
| 人声分离 | BS-Roformer `.ckpt` + `.yaml` | 约 639 MB | 必需 |
| 插件本体 | npm 包 / 市场索引 / 源码 | 约 1 MB | 安装插件时 |

必需下载合计约 **4.1 GB**（其中模型文件约 3.8 GB、Whisper base 约 0.29 GB；不含 venv 里的 Python 包），与文档里「首次约 7–9 GB」的口径一致。

---

## 1. 系统底座（项目没有内置下载地址，需要自备）

| 项 | 要求 | 说明 |
|---|---|---|
| Python | 3.10–3.12 | 项目只用系统 Python 建 venv，不提供安装包地址。官方：<https://www.python.org/downloads/>；macOS 也可 `brew install python@3.12` |
| Node.js | ≥ 22.13 | DSH 自带，无需单独下载 |
| ffmpeg | 任意较新版本 | 系统 PATH 里有就直接用；没有就 `pip install imageio-ffmpeg`（wheel 自带对应平台二进制），路径写回 `settings.ffmpeg` |
| NVIDIA 驱动 | 可选 | 只有装 CUDA 轮子时才需要；CUDA runtime 由 PyTorch wheel 自带，不用单独装 CUDA Toolkit |

代码里的查找顺序：`systemPython` → Windows `py -3.12 / -3.11 / -3.10`、`python` → 其他平台 `python3.12 / python3.11 / python3.10 / python3 / python`。

---

## 2. Python 包与源

### 2.1 包索引

| 用途 | 地址 |
|---|---|
| 清华 PyPI 镜像（默认首选） | <https://pypi.tuna.tsinghua.edu.cn/simple> |
| PyPI 官方源（回退） | <https://pypi.org/simple> |
| PyTorch CUDA 12.1 轮子 | <https://download.pytorch.org/whl/cu121> |
| PyTorch CPU 轮子 | 清华镜像 → 官方 PyPI |

所有 pip 安装（升级 pip、两份 requirements、`audio-separator`、`imageio-ffmpeg`、训练用的 TensorBoard / scikit-learn）都先带 `--index-url https://pypi.tuna.tsinghua.edu.cn/simple`，失败再回退 `https://pypi.org/simple`；启动 DSH 前设了 `PIP_INDEX_URL` 就改用自己的源。

装包工具**优先用 uv**：检测到 uv（`settings.uvPath`、PATH，或 `~/.local/bin`、`/opt/homebrew/bin`、`/usr/local/bin`）就用 `uv venv --seed` 建环境、`uv pip install` 装依赖；没有 uv、`uvPath` 不可执行或 uv 执行报错时，退回 `python -m venv` + `pip`。两种工具都保持「清华 → 官方」的源顺序。

安装 PyTorch 时的逻辑：检测到 `nvidia-smi` → 先试 `--index-url https://download.pytorch.org/whl/cu121`，失败则回退 CPU 轮子（清华镜像优先）；没有 NVIDIA 直接装 CPU 轮子。**CUDA 轮子是唯一不走清华的**：清华只镜像 conda 的 pytorch 频道，没有 pip 版 CUDA 轮子，只能直连官方索引。

### 2.2 两个 venv 的固定版本

| venv | torch / torchaudio |
|---|---|
| `runtime/venv-rvc` | `2.4.1` |
| `runtime/venv-soulx` | `2.2.0` |
| `runtime/venv-separator` | 不锁版本，装 `audio-separator` |

### 2.3 requirements 里的包（都从上面的 PyPI 源解析）

`engine/requirements-rvc.txt`：

```text
numpy<2
scipy>=1.11,<2
librosa>=0.10,<0.11
soundfile>=0.12
faiss-cpu
tensorboard>=2.9
matplotlib>=3.7
scikit-learn>=1.0
transformers>=4.40,<5
av>=12
praat-parselmouth>=0.4
PyYAML
tqdm
einops
imageio-ffmpeg
setuptools<81
```

`engine/requirements-soulx.txt`：

```text
transformers==4.41.2
librosa==0.11.0
numpy<2
scipy==1.15.3
accelerate==1.11.0
omegaconf==2.3.0
soundfile==0.13.1
tqdm
huggingface_hub
setuptools<81
imageio-ffmpeg
```

另外单独安装：`audio-separator`（人声分离，PyPI）、`tensorboard>=2.9`、`scikit-learn>=1.0`（训练可选）。

---

## 3. 模型与资源文件

下载顺序：**hf-mirror 优先，huggingface.co 回退**；分离模型的 `.ckpt` 再补一条 GitHub Release。任一线路成功即停，所以国内环境不会先在官方站上白等超时。
下载器 `engine/download.py` 支持 `.part` 断点续传、`Content-Length` 大小校验和 `sha256` 校验。

### 3.1 RVC 运行必需（约 371 MB）

**RMVPE 音高模型** → `runtime/rvc/assets/rmvpe/rmvpe.pt`（181,184,272 字节，安装器会校验大小）

```text
https://hf-mirror.com/lj1995/VoiceConversionWebUI/resolve/main/rmvpe.pt
https://huggingface.co/lj1995/VoiceConversionWebUI/resolve/main/rmvpe.pt
```

**HuBERT 内容模型** → `runtime/rvc/assets/hubert_base/`（共 3 个文件，`pytorch_model.bin` 为 189,206,711 字节；一键安装会就地生成 `model.safetensors`，因为 transformers 4.56+ 在 torch<2.6 下拒绝加载 `.bin`）

```text
https://hf-mirror.com/lj1995/VoiceConversionWebUI/resolve/main/hubert_base/config.json
https://hf-mirror.com/lj1995/VoiceConversionWebUI/resolve/main/hubert_base/preprocessor_config.json
https://hf-mirror.com/lj1995/VoiceConversionWebUI/resolve/main/hubert_base/pytorch_model.bin
```

官方站线路就是把域名 `hf-mirror.com` 换成 `huggingface.co`，路径不变。

### 3.2 RVC 训练底模（可选，约 218 MB）

| 文件 | 大小 | 目标路径 |
|---|---|---|
| `f0G48k.pth` | 75,465,569 字节 | `runtime/rvc/assets/pretrained_v2/f0G48k.pth` |
| `f0D48k.pth` | 142,875,703 字节 | `runtime/rvc/assets/pretrained_v2/f0D48k.pth` |

```text
https://hf-mirror.com/lj1995/VoiceConversionWebUI/resolve/main/pretrained_v2/f0G48k.pth
https://hf-mirror.com/lj1995/VoiceConversionWebUI/resolve/main/pretrained_v2/f0D48k.pth
https://huggingface.co/lj1995/VoiceConversionWebUI/resolve/main/pretrained_v2/f0G48k.pth
https://huggingface.co/lj1995/VoiceConversionWebUI/resolve/main/pretrained_v2/f0D48k.pth
```

### 3.3 SoulX-Singer（约 2.79 GB）

**换声模型** → `runtime/models/soulx/model-svc.pt`（2,793,965,154 字节，校验大小）

```text
https://hf-mirror.com/Soul-AILab/SoulX-Singer/resolve/main/model-svc.pt
https://huggingface.co/Soul-AILab/SoulX-Singer/resolve/main/model-svc.pt
```

**Whisper base**（SoulX 的内容编码器，约 290 MB）——由 `transformers` 的 `from_pretrained("openai/whisper-base")` 自动拉取，落在 Hugging Face 缓存。安装时会把 `HF_ENDPOINT` 设为 `https://hf-mirror.com`，所以这条也走镜像：

```text
仓库：openai/whisper-base
镜像地址（HF_ENDPOINT 生效时）：https://hf-mirror.com/openai/whisper-base
官方地址：https://huggingface.co/openai/whisper-base
缓存目录：$HF_HOME/hub/models--openai--whisper-base
        或 ~/.cache/huggingface/hub/models--openai--whisper-base
```

想换回官方站或别的镜像，启动 DSH 前设置 `HF_ENDPOINT` 即可，安装器不会覆盖已有的值。

### 3.4 人声分离模型（约 639 MB）

模型名：`model_bs_roformer_ep_317_sdr_12.9755`，目标目录 `runtime/models/separator/`。

`.ckpt`（实际 639,331,213 字节；安装器不校验大小，只校验 sha256）：

```text
https://hf-mirror.com/Politrees/UVR_resources/resolve/main/models/Roformer/BandSplit/model_bs_roformer_ep_317_sdr_12.9755.ckpt
https://huggingface.co/Politrees/UVR_resources/resolve/main/models/Roformer/BandSplit/model_bs_roformer_ep_317_sdr_12.9755.ckpt
https://github.com/nomadkaraoke/python-audio-separator/releases/download/model-configs/model_bs_roformer_ep_317_sdr_12.9755.ckpt
```

`.yaml`（2,273 字节，只有 GitHub Release 一条线路）：

```text
https://github.com/nomadkaraoke/python-audio-separator/releases/download/model-configs/model_bs_roformer_ep_317_sdr_12.9755.yaml
```

校验值：

```text
ckpt sha256 = 5b84f37e8d444c8cb30c79d77f613a41c05868ff9c9ac6c7049c00aefae115aa
yaml sha256 = 2bfdd16c656bd9519aba757cc4f8834b7ede675eb1e00ec4772d74ae1c41af7f
```

在 macOS / Linux 上核对：`shasum -a 256 <文件>`。

---

## 4. 插件本体与市场

| 用途 | 地址 |
|---|---|
| npm 官方源 | <https://registry.npmjs.org/> |
| 国内镜像（README 推荐） | <https://registry.npmmirror.com/> |
| 包页面（看镜像同步状态） | <https://npmmirror.com/package/dsh-singing-studio> |
| 手动触发镜像同步 | `curl -X PUT https://registry.npmmirror.com/-/package/dsh-singing-studio/syncs` |
| 市场索引（DSH 读取的清单） | <https://raw.githubusercontent.com/Dhao007/dsh-singing-studio/main/market/index.json> |
| 仓库 | <https://github.com/Dhao007/dsh-singing-studio> |
| Release 包 | <https://github.com/Dhao007/dsh-singing-studio/releases/latest/download/dsh-singing-studio.tgz> |
| 图标 | <https://raw.githubusercontent.com/Dhao007/dsh-singing-studio/main/assets/icon-180.png> |
| 社区插件总表（提 PR 用） | <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>、索引 <https://awesome-dsh-plugin.com/plugins.json> |
| npm trusted publishing 文档 | <https://docs.npmjs.com/trusted-publishers> |

本地源码安装不需要下载：`npm pack` 生成 tgz，或直接把插件目录填进 Add plugin。

---

## 5. 镜像、代理与校验行为（排错时看这里）

- **代理**：插件数据目录 `settings.json` 里的 `proxy` 会同时设进 `HTTP_PROXY / HTTPS_PROXY / http_proxy / https_proxy`，作用于 pip 安装和 `engine/download.py`；不会改动系统代理。
- **pip 源**：统一走 `pipInstall()`：清华 PyPI 镜像 → 官方 PyPI。镜像缺包、证书或超时时自动回退，失败信息里会说明两个源都试过；`PIP_INDEX_URL` 可覆盖首选源。
- **HF 线路**：所有 Hugging Face 资源统一走 hf-mirror.com。直连模型（RVC / SoulX / 分离模型）用 `hfUrls()`：先镜像、失败再回退 huggingface.co；Whisper 这类由 `transformers` 自己下载的，安装时用 `hfEndpointEnv()` 把 `HF_ENDPOINT` 指到镜像。安装器和「手动下载」清单共用同一份顺序。本次核查时本机直连 `huggingface.co` 20 秒超时、`hf-mirror.com` 全部正常，镜像优先可以省掉这段等待。
- **断点续传**：下载中的数据在 `<目标文件>.part`，中断后重跑会带 `Range` 续传；文件已存在且大小（或 sha256）匹配时直接跳过。
- **Whisper 不在下载清单里**：它由 `transformers` 自己下载缓存，所以「手动下载」界面不会列出它；要手动准备，就按第 3.3 节的缓存目录放置。
- **校验差异**：`rmvpe.pt`、`f0G48k.pth`、`f0D48k.pth`、`model-svc.pt` 校验大小；分离模型的 ckpt / yaml 校验 sha256；HuBERT 三个文件不校验。
- 代理只影响 pip 和内置下载器；如果你用浏览器手动下大文件，需要自己在浏览器 / 系统层配代理。

---

## 6. 第三方出处（不是运行环境下载，仅追溯）

| 项目 | 地址 |
|---|---|
| RVC | <https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI> |
| RVC 模型仓库 | <https://huggingface.co/lj1995/VoiceConversionWebUI/tree/main> |
| SoulX-Singer | <https://github.com/Soul-AILab/SoulX-Singer> |
| SoulX 模型 / Space / 评测集 / MIDI 编辑器 | <https://huggingface.co/Soul-AILab/SoulX-Singer>、<https://huggingface.co/spaces/Soul-AILab/SoulX-Singer>、<https://huggingface.co/datasets/Soul-AILab/SoulX-Singer-Eval-Dataset>、<https://huggingface.co/spaces/Soul-AILab/SoulX-Singer-Midi-Editor> |
| 技术报告 | <https://arxiv.org/abs/2602.07803> |
| UVR 资源（分离模型宿主） | <https://huggingface.co/Politrees/UVR_resources> |
| python-audio-separator | <https://github.com/nomadkaraoke/python-audio-separator> |
| F5-TTS / Amphion / RMVPE / Paraformer 等参考实现 | 见 `vendor/soulx/README.md` 与 `vendor/rvc/README.md` |

---

## 7. 本次核查记录

- 2026-11-11 用 HEAD 请求逐条验证 `hf-mirror.com`：RMVPE、HuBERT、`f0G48k/f0D48k`、`model-svc.pt`、BS-Roformer ckpt 均返回 200，`Content-Length` 与代码里的 `size` 完全一致。
- GitHub Release 的 `.yaml` 返回 200，大小 2,273 字节；`download.pytorch.org/whl/cu121` 返回 200。
- `huggingface.co` 本机直连 20 秒无响应（超时），`hf-mirror.com` 正常；据此把下载顺序改为镜像优先，官方站只作回退。
- 清华 PyPI 镜像实测可用（`pip download six` 命中 `pypi.tuna.tsinghua.edu.cn`）；`mirrors.tuna.tsinghua.edu.cn/pytorch-wheels/cu121/` 为 404，确认清华没有 pip 版 CUDA 轮子镜像。
- 体积口径差异：`docs/GUIDE.md` 写 Whisper base「约 150 MB」，实测 `model.safetensors` 为 290,403,936 字节（约 290 MB），按实测值理解即可。

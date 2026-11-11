# 唱歌工作室 · 完整说明

> 这是 `dsh-singing-studio` 的完整使用文档。快速安装和功能概览见 [README](../README.md)。

DSH Web UI 插件：安装环境 → 训练 / 选择音色 → 上传整首歌 → 分离人声/伴奏 → RMVPE 分析 F0 → 八度规划 → 用 RVC 或 SoulX-Singer SVC 生成翻唱。整体只有四个页面：环境安装、RVC训练、制作台、设置。

## 功能

- 时间轴 F0、舒适区/极限区音域带、越界阴影、覆盖率热力条。
- 乐句切分：点乐句高亮对应 F0，并可只播放该句；播放条可切换原曲 / 翻唱。
- 网易云搜歌与下载：免费歌直接下；会员/版权歌可填 MUSIC_U Cookie。
- 制作台歌曲库：显示已下载歌曲、分析次数和已翻唱版本；已有翻唱可以直接试听 / 下载。
- 多任务生成队列：可以连续加入多个生成任务，完成一个会弹应用内提醒（允许时也发系统通知）。
- 成品本地缓存：同一分析 + 音色 + 后端 + 八度方案 + 渲染参数只生成一次，重复点生成直接复用。
- 自绘播放条：点任意位置或拖动都能跳转并继续播放；可在原曲 / 翻唱之间切换，翻唱支持在已缓存的多个八度方案之间选择试听。
- 每个八度方案单独缓存成品：方案表有「成品」列，可一键试听某个方案的结果，不用重新生成。
- 切换试听版本时，时间轴的处理后曲线 / 变调轨 / 覆盖率热力条和「音色区间」的音域、覆盖率会同步切换。
- 全局 / 分段 / 乐句三层互斥的八度规划（动态规划），只移人声八度，伴奏不动。
- RVC 音色训练：填唱歌数据目录，按「切分 → F0 / HuBERT → 训练 → 索引 → 音域 Profile」一条龙跑完；进度条显示每个 epoch 的拟合度、mel loss 和预计剩余时间。
- 两个换声后端：
  - **RVC**：已训练音色，速度快。
  - **SoulX-Singer SVC**：零样本，用参考音频克隆音色，无需训练。
- 跨平台依赖检查、下载、环境准备。
- RVC / SoulX 常驻 Worker：模型加载一次，后续分析和渲染复用；自动 CUDA / CPU。
- 环境未就绪时禁止歌曲分析、八度处理和生成。

## 环境要求

- Node.js >= 22.13（DSH 自带）。
- Python 3.10–3.12（用于创建两个独立 venv；插件会自动寻找）。
- 磁盘：首次准备约 7–9 GB（两个 venv + RVC 资源 + SoulX 模型 + 分离模型）；训练底模另加约 208 MB。
- GPU：NVIDIA CUDA 时自动装 CUDA 轮子并使用 GPU；否则 CPU。
  - Apple Silicon 使用 CPU。SoulX 的 STFT 目前在 MPS 上不可用，所以不走 MPS。

## 安装为 DSH 插件

安装方式见 [README 的「安装」一节](../README.md#安装)：插件市场搜索安装（npm，走 `registry.npmmirror.com`）、手动填包名安装，或本地 `npm pack` 后安装 tarball / 源码目录。

安装后侧栏出现「唱歌」。**第一次打开会直接停在「环境安装」页**：点「一键安装」即可；环境没就绪时会自动把用户带回这一页。

## 界面

只有四个页面：

| 页面 | 内容 |
|---|---|
| 环境安装 | 依赖清单、设备、Worker 常驻、一键安装（带预计剩余时间）、手动下载清单 |
| RVC训练 | 唱歌数据路径、常用训练参数、逐 epoch 的拟合度 / mel loss / 预计剩余时间、可复制的权重路径 |
| 制作台 | 歌曲库、已翻唱版本、F0 分析 → 八度方案 → 生成、多任务队列；内部还有「音高时间轴」和「八度方案」两个视图 |
| 设置 | 通用行为与下载代理；安装路径由插件自动管理 |

环境安装页只放一键安装和下载兜底；RVC训练页管训练参数；制作台页管网易云 Cookie、八度规划、F0 分析和 SoulX 参数；设置页放通用行为和下载代理。

训练和生成都在后台跑，切页或切到其他 DSH 面板不会中断；切回来会恢复歌曲、分析、方案、成品、播放位置和队列进度。试听条只在制作台显示；切到其他页面会自动暂停并保留进度。

## 环境安装

「环境安装」页会检查：

| 项 | 说明 |
|---|---|
| 系统 Python | 3.10–3.12 |
| RVC Python | venv + torch/torchaudio/librosa/faiss/transformers/av/parselmouth |
| RVC 代码 | 插件内置 `vendor/rvc`，缺了会复制 |
| RVC 资源 | `rmvpe.pt`（181 MB）+ `hubert_base`（189 MB） |
| RVC 训练代码 | 插件内置 `vendor/rvc/train`，缺了会复制 |
| RVC 训练依赖 | TensorBoard + scikit-learn（训练可选） |
| RVC 训练底模 | `pretrained_v2/f0G48k.pth` + `f0D48k.pth`（约 208 MB，训练可选） |
| ffmpeg | 系统有就用；没有就装 `imageio-ffmpeg` |
| 人声分离 | `audio-separator` + BS-Roformer 模型 |
| SoulX Python | venv + torch 2.2/transformers 等 |
| SoulX 代码 | 插件内置 `vendor/soulx` |
| SoulX 模型 | `model-svc.pt`（约 2.6 GB） |
| Whisper base | SoulX 的内容编码器（约 150 MB） |

音色模型不计入环境安装检查：环境就绪后，在「制作台」选择已有音色，或先去「RVC训练」训练一个。

点「一键安装 / 继续安装」会按顺序创建 venv、安装依赖、下载缺失文件；进度条会显示当前阶段和预计剩余时间。已有文件会跳过，下载走 `.part` 文件断点续传——中途退出后再点一次即可继续。

「依赖清单」和「手动下载 / 离线安装」默认都是收起的，首次使用只需要点「一键安装」，不用先看一长串依赖。如果某个文件下载失败，页面会自动展开「手动下载」、高亮失败项并给出它的下载线路和目标路径；把已经下载好的文件拖进该项的虚线框（或点击选择），插件会校验扩展名/大小并直接放进目标路径，成功后自动刷新清单。也可以复制目标路径自己放置，再点「重新检查环境」。

下载慢可以在「设置 → 下载」里填代理。

### 安装位置

默认 **managed** 模式：代码、venv、模型都由插件放在
`~/.dsh/plugins-data/singing-studio/runtime/`，不需要手动配置。

开发和调试时如果要复用项目里已有的 `.venv-rvc`、`third_party/rvc`、`model/SoulX-Singer`，
可以改插件数据目录下的 `settings.json`（`mode: existing` + `projectRoot`）；界面上不再暴露路径配置。

### GPU / CPU

- 安装 PyTorch 时检测 `nvidia-smi`：有 NVIDIA 就装 CUDA 轮子，否则 CPU。
- Worker 启动时再检测 `torch.cuda.is_available()`：CUDA 可用就用 GPU，否则 CPU。
- 面板显示「设备：RVC CUDA/CPU · SoulX CUDA/CPU」和模型是否常驻。
- 模型加载后进程保持存活；后续分析和渲染不再重新加载。
- 在「设备与常驻」卡片里可以「预加载 RVC / SoulX」：加载中显示小圆圈百分比，随时可以点「暂停」终止加载；加载完成后同一位置显示 100% 和「卸载模型」，只停掉对应后端的 Worker 进程，另一个后端不受影响。

## 音色模型和 Profile

发行包不包含任何人的音色模型。使用前需要：

1. 放一个 RVC `.pth` 到 `modelsDir`。
2. 准备 `profiles/<model-id>.json`，至少包含：
   ```json
   {
     "id": "my_voice",
     "label": "我的音色",
     "p1": 180, "p5": 210, "p50": 340, "p95": 520, "p99": 590,
     "promptWav": "path/to/reference.wav"
   }
   ```
   `promptWav` 是 SoulX-SVC 的参考音频（5–15 秒干净干声，优先演唱片段）。
3. 分析/规划会读取这些值作为音域带。

`profiles/` 可以放插件目录（内置）或插件数据目录（训练自动生成），两处会合并读取，同 id 时数据目录优先。发行包不带任何示例音色；字段说明和模板见 [`profiles/README.md`](../profiles/README.md)。

## 训练 RVC 音色

「RVC训练」页填一个装着唱歌音频的文件夹（支持子目录，wav / flac / mp3 / m4a / ogg），起一个模型名，点「开始训练」即可。常用参数只有采样率和总轮数；版本、批大小、切片、F0 方法、设备、底模、索引都在「高级参数」里默认折叠。

1. 自动切分音频、提取 F0（RMVPE）和 HuBERT 特征。
2. 默认配置是 48k / v2 / 20 轮 / 批大小 4；展开「高级参数」可以改版本、批大小、保存间隔、切片长度、F0 方法、并行进程、设备、预训练底模和检索索引。
3. 每个 epoch 更新一次拟合度：`100 × (1 − e^(−18 / mel loss))`，只反映训练趋势，不代表绝对音质。
4. 训练完成自动构建 faiss 索引（可选），并从训练集采样 RMVPE 生成音域 Profile；权重路径和 Profile 路径会显示在结果卡里，点「复制权重路径」即可拿到 `.pth` 的完整路径。

训练进程收到取消会连子进程一起结束；CPU 训练较慢，建议用 NVIDIA GPU。每个 epoch 的 G/D 检查点保存在 `<rvcDir>/logs/<模型名>/`；目前不自动断点续训，同名训练目录已存在时会提示换一个模型名。训练出的 Profile 默认没有 `promptWav`；如果要给这个音色用 SoulX-SVC，需要再补一段 5–15 秒的干净参考音频。

## 使用

1. 侧栏「唱歌」，先在「环境安装」页一键安装。
2. 去「RVC训练」训练自己的音色（或直接用已有音色）。
3. 打开「制作台」：歌曲库会列出已下载的歌和已翻唱版本。
4. 没有翻唱的歌：选歌 → 分析 F0 → 生成八度方案 → 选方案 → 生成歌曲。已有同音色分析的歌会自动复用分析结果。
5. 生成任务会进入队列，可连续加入多个；完成一个会提醒。已翻唱版本可直接试听 / 下载。
6. 时间轴和方案详情在「制作台」顶部的两个视图里。

## 网易云搜歌

「制作台」里可以搜歌名或歌手，下载后自动加入歌曲库。免费歌不需要登录；会员 / 版权歌在「制作台设置 → 网易云下载」里填网易云的 `MUSIC_U` Cookie（只保存在本机，不会回显）。

## 数据目录

`~/.dsh/plugins-data/singing-studio/`

- `songs/<id>/`：上传源、`vocals.wav`、`instrumental.wav`
- `analysis/`、`plans/`、`renders/`
- `profiles/`：训练自动生成的音域 Profile
- `training/`：训练任务的结果 JSON 和日志
- `runtime/`：managed 模式的代码、venv、模型
- `settings.json`、`history.json`

## 已知限制

- SoulX 接入的是 **SVC（换声）**，不是 SVS；不能改词重唱，音域宽度问题仍靠八度规划缓解。
- 只允许八度折叠；对 loli 这类音域很窄的模型，覆盖率提升有限。
- SoulX CPU 推理较慢：122 秒整首 4 步约 2.5 分钟，16 步约 8–10 分钟。
- 发行包不包含音色 `.pth`，需要按实际音色准备并确认授权。
- 首次准备依赖网络；国内可设置 `proxy`。安装中断后可以继续，已下载完成的文件不会重下。
- 同一时间只有一个后台任务真正占用模型，其他生成任务会排队；队列完成后会提醒。
- RVC 训练在 Apple Silicon / CPU 上很慢；拟合度是由 mel loss 换算的经验值，只用于看趋势。
- 训练后自动生成的 Profile 采样训练集音频；如果训练集混入伴奏或混响，音域统计会偏高。

## 许可证

插件代码 MIT。内置 RVC（MIT）和 SoulX-Singer（Apache-2.0）；下载的模型/工具遵循各自许可证，详见 `THIRD_PARTY_NOTICES.md`。

## 平台差异

| 平台 | Python | GPU | 说明 |
|---|---|---|---|
| macOS | 3.10–3.12 | CPU | Apple Silicon 不走 MPS（SoulX STFT 不支持）；RVC/SoulX 用 CPU |
| Windows | 3.10–3.12（`py` 启动器） | NVIDIA CUDA / CPU | 自动使用 `Scripts\python.exe`、`Scripts\audio-separator.exe`、`ffmpeg.exe` |
| Linux | 3.10–3.12 | NVIDIA CUDA / CPU | 自动使用 `bin/python`；需要 NVIDIA 驱动才能用 CUDA 轮子 |

安装器会自动识别平台路径、venv 结构、ffmpeg 可执行文件；不需要手工改路径。若系统 Python 不在 PATH，可在设置里填 `systemPython`。

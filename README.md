# 唱歌工作室 · dsh-singing-studio

DSH Web UI 插件：一键准备环境，训练 RVC 音色，分离人声，分析 F0 并规划八度，最后用 RVC 或 SoulX-Singer 生成翻唱。

## 插件功能

- **环境安装**：检查 Python / venv / RVC / SoulX / ffmpeg / 人声分离模型，一键安装并支持断点续传；失败项会展开下载线路，也可以把已下载的文件拖进目标框。
- **RVC 音色训练**：填唱歌数据目录，自动完成切分 → F0 / HuBERT → 训练 → faiss 索引 → 音域 Profile；进度显示拟合度、mel loss 和预计剩余时间。
- **已有模型导入**：复用已有 `.pth` / 模型包，校验格式和 Profile，按训练数据生成音域 Profile 后加入模型库，不需要重新训练。
- **SoulX 零样本音色**：用一段干净参考音频创建音色，自动生成音域 Profile，不需要 RVC 权重或训练。
- **人声分离**：BS-Roformer 分离人声 / 伴奏；设置页可选标准 / 快速 / 极速，快速模式通过减少重叠预测窗口明显提速。
- **F0 分析与八度规划**：全局 / 分段 / 乐句三层八度规划，只移人声、不动伴奏；时间轴显示舒适区、极限区、变调轨和覆盖率。
- **制作台**：歌曲库、已翻唱版本、乐句试听、方案对比、多任务生成队列和成品缓存。
- **两种换声后端**：RVC（已训练音色，速度快）和 SoulX-Singer SVC（零样本，用参考音频克隆）。
- **常驻 Worker**：模型加载一次后复用，自动 CUDA / CPU；支持预加载、暂停和单独卸载，切页或切 DSH 面板不中断任务。
- **网易云搜歌**：免费歌直接下载；会员 / 版权歌可填 `MUSIC_U` Cookie。

## 安装

### 环境要求

| 项 | 要求 |
|---|---|
| DSH | `>= 0.2.1-rc.3` |
| Node.js | `>= 22.13`（DSH 自带） |
| Python | 3.10–3.12，用于创建 RVC / SoulX / 分离器三个 venv |
| 磁盘 | 首次约 7–9 GB（venv + 模型）；训练底模另加约 208 MB |
| GPU | NVIDIA CUDA 自动加速；Apple Silicon 的 RVC / SoulX 走 CPU、分轨走 MPS；其他环境走 CPU |

### 安装插件

在 DSH 中打开 **Plugins → Add plugin**，填入本仓库的 Git 地址：

```text
https://github.com/Dhao007/dsh-singing-studio
```

也可以使用本地源码或 tarball：

```bash
git clone https://github.com/Dhao007/dsh-singing-studio.git
# Add plugin 里填克隆下来的绝对路径

# 或者先打包，再把生成的 tgz 绝对路径填进 Add plugin
npm pack
```

如果 npm 上已经能查到本插件，也可以直接填包名：

```text
dsh-singing-studio@0.1.0
```

包名安装时把 Registry 切到「国内镜像（npmmirror）」；Git / 本地路径安装不需要。

### 第一次使用

1. 安装后侧栏出现「唱歌」，打开会进入「环境安装」。
2. 点「一键安装 / 继续安装」，等待依赖和模型下载完成；中断后再点一次会续传。
3. 去「RVC训练」训练新音色、导入已有模型，或创建 SoulX 音色。
4. 打开「制作台」：选歌 → 分析 F0 → 生成八度方案 → 选方案 → 生成翻唱。

环境未就绪时分析和生成会保持禁用，插件会自动把用户带回「环境安装」页。

## 参考仓库

| 项目 | 用途 | 许可证 |
|---|---|---|
| [RVC-Project/Retrieval-based-Voice-Conversion-WebUI](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI) | RVC 推理与训练代码 | MIT |
| [Soul-AILab/SoulX-Singer](https://github.com/Soul-AILab/SoulX-Singer) | SoulX-Singer SVC 与模型 | Apache-2.0 |
| [nomadkaraoke/python-audio-separator](https://github.com/nomadkaraoke/python-audio-separator) | 人声 / 伴奏分离 | MIT |
| [Anjok07/ultimatevocalremovergui](https://github.com/Anjok07/ultimatevocalremovergui) | BS-Roformer 分离模型生态 | 见上游模型许可 |
| [openai/whisper](https://github.com/openai/whisper) | SoulX 使用的 Whisper 编码器 | MIT |
| [lj1995/VoiceConversionWebUI](https://huggingface.co/lj1995/VoiceConversionWebUI) | RMVPE / HuBERT / RVC 预训练底模 | 见模型页 |

## 许可证

插件代码使用 **MIT License**，见 [LICENSE](LICENSE)。

插件内置 RVC（MIT）和 SoulX-Singer（Apache-2.0）；安装时下载的 PyTorch、transformers、audio-separator、BS-Roformer、RMVPE / HuBERT、Whisper 等遵循各自许可证。完整清单见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

音色权重、Profile 和参考音频由用户提供；请确认拥有相应的声音授权，不要分发无授权的音色。

更完整的页面说明、参数、数据目录和已知限制见 [docs/GUIDE.md](docs/GUIDE.md)，全部下载地址见 [docs/DOWNLOADS.md](docs/DOWNLOADS.md)。

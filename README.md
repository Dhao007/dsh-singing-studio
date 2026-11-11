# 唱歌工作室 · dsh-singing-studio

训练音色模型 → 上传整首歌 → 分离人声 → 分析 F0 → 规划八度 → 用 RVC / SoulX-Singer 生成翻唱。

## 功能

- **环境安装**：跨平台检查 Python / venv / RVC / SoulX / ffmpeg / 人声分离模型；依赖清单默认收起，点「一键安装」即可，支持断点续传；安装路径自动管理；下载失败时自动展开对应链接，可把已下载的文件拖进目标框。
- **RVC 音色训练**：填一个唱歌数据目录，自动切分 → F0 / HuBERT → 训练 → faiss 索引 → 音域 Profile；逐 epoch 显示拟合度、mel loss 和预计剩余时间。
- **制作台**：歌曲库、已翻唱版本、F0 时间轴、乐句试听、八度方案表、多任务生成队列。
- **音域规划**：全局 / 分段 / 乐句三层八度规划，只移人声、不动伴奏；时间轴显示舒适区、极限区和覆盖率。
- **两种换声后端**：RVC（已训练音色，速度快）和 SoulX-Singer SVC（零样本，用参考音频克隆，不用训练）。
- **常驻 Worker**：模型只加载一次，后续复用，自动 CUDA / CPU；在「设备与常驻」里预加载，圆形进度可暂停，加载完可单独卸载对应进程；切页、切 DSH 面板不中断任务。
- **网易云搜歌**：免费歌直接下载；会员 / 版权歌可填 `MUSIC_U` Cookie。
- **成品缓存**：相同的分析 + 音色 + 后端 + 八度方案 + 渲染参数只生成一次，可直接复用。

## 环境要求

| 项 | 要求 |
|---|---|
| Node.js | ≥ 22.13（DSH 自带） |
| Python | 3.10–3.12 |
| 磁盘 | 首次约 7–9 GB（两个 venv + 模型）；训练底模另加约 208 MB |
| GPU | 有 NVIDIA CUDA 自动用 GPU，否则 CPU；Apple Silicon 走 CPU |

## 安装

**Plugins → Add plugin**，包名填：

```text
dsh-singing-studio@0.1.0
```

**Registry** 选「国内镜像（npmmirror）」，再点安装。

> 包名安装报 404 时（npm 还没发布或镜像没同步），可以走源码安装：`npm pack` 后把生成的 tgz 路径填进 **Add plugin**，开发时也可以直接填插件目录。

## 使用

1. 打开「环境安装」，点「一键安装 / 继续安装」，等它跑完。下载支持断点续传，中断后再点一次会继续。
2. 去「RVC训练」训练自己的音色。
3. 打开「制作台」：选歌 → 分析 F0 → 生成八度方案 → 选方案 → 生成翻唱。

## 数据目录

```text
~/.dsh/plugins-data/singing-studio/
├── songs/         上传源、vocals.wav、instrumental.wav
├── analysis/       F0 分析结果
├── plans/          八度方案
├── renders/        成品缓存
├── profiles/       训练自动生成的音域 Profile
├── training/       训练结果和日志
├── runtime/        managed 模式的代码、venv、模型
├── settings.json
└── history.json
```

## 已知限制

- SoulX 接入的是 SVC 换声，不是 SVS：不能改词重唱。
- 只支持八度折叠；音域很窄的音色提升有限。
- 首次准备依赖网络，国内建议在「设置 → 下载」里填代理；CPU 推理较慢。
- 同一时间只有一个任务真正占用模型，其他生成任务排队。

## 许可证

插件代码 MIT，见 [LICENSE](LICENSE)。内置 RVC（MIT）和 SoulX-Singer（Apache-2.0）；下载的模型 / 工具遵循各自许可证，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

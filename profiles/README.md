# 音色 Profile

这个目录用来放**示例 / 内置**音域 Profile；训练器自动生成的 Profile 写到插件数据目录：

```text
~/.dsh/plugins-data/singing-studio/profiles/
```

两处会合并读取，同 `id` 时数据目录优先。发行包不包含任何 `.pth` 音色权重。

## 格式

文件名建议与 RVC 权重同名，例如 `my_voice.pth` → `my_voice.json`：

```json
{
  "id": "my_voice",
  "label": "我的音色",
  "model": "my_voice.pth",
  "method": "rmvpe",
  "fps": 100,
  "p1": 180,
  "p5": 210,
  "p50": 340,
  "p95": 520,
  "p99": 590,
  "promptWav": "/绝对路径/reference.wav",
  "notes": "可选备注"
}
```

- `p1` / `p5` / `p50` / `p95` / `p99`：音高分布百分位（MIDI），用来画音域带和算覆盖率。
- `promptWav`：SoulX-Singer SVC 的参考音频，5–15 秒干净干声，优先用演唱片段；只用 RVC 时可以省略。
- 不想手写的话，在「RVC训练」页训练完会自动生成一份 Profile。

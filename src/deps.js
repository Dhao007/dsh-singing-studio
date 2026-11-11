import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { BIN_DIR, IS_WIN, ensureDir, venvBin, venvPython } from './store.js'

const HF = {
  rvc: 'https://huggingface.co/lj1995/VoiceConversionWebUI/resolve/main',
  rvcMirror: 'https://hf-mirror.com/lj1995/VoiceConversionWebUI/resolve/main',
  soulx: 'https://huggingface.co/Soul-AILab/SoulX-Singer/resolve/main',
  soulxMirror: 'https://hf-mirror.com/Soul-AILab/SoulX-Singer/resolve/main',
}

const SEP_MODEL = 'model_bs_roformer_ep_317_sdr_12.9755'
const SEP_CKPT_SHA = '5b84f37e8d444c8cb30c79d77f613a41c05868ff9c9ac6c7049c00aefae115aa'
const SEP_YAML_SHA = '2bfdd16c656bd9519aba757cc4f8834b7ede675eb1e00ec4772d74ae1c41af7f'

const REQUIRED_MODULES_RVC = ['torch', 'torchaudio', 'librosa', 'soundfile', 'numpy', 'scipy', 'faiss', 'transformers', 'av', 'parselmouth', 'yaml']
const REQUIRED_MODULES_TRAIN = ['tensorboard', 'sklearn']
const REQUIRED_MODULES_SOULX = ['torch', 'torchaudio', 'transformers', 'librosa', 'soundfile', 'numpy', 'scipy', 'omegaconf', 'accelerate']

let cache = { at: 0, key: '', value: null }

export function invalidateDeps() {
  cache = { at: 0, key: '', value: null }
}

function keyOf(settings) {
  return JSON.stringify({
    mode: settings.mode, root: settings.projectRoot, runtime: settings.runtimeRoot,
    rvc: settings.rvcDir, models: settings.modelsDir, python: settings.pythonPath,
    soulxDir: settings.soulxDir, soulxPython: settings.soulxPython, soulxModel: settings.soulxModel,
    sep: settings.separatorExe, sepDir: settings.separatorModelDir, ffmpeg: settings.ffmpeg,
  })
}

export function commandExists(cmd) {
  const finder = IS_WIN ? 'where' : 'which'
  const r = spawnSync(finder, [cmd], { encoding: 'utf8', timeout: 4000, windowsHide: true })
  return r.status === 0
}

export function runSync(cmd, args, timeout = 15000) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout, windowsHide: true })
}

export function run(cmd, args, { cwd, env, onLine, timeoutMs = 0, job } = {}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(cmd, args, {
        cwd,
        env: { ...process.env, ...(env || {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) { reject(error); return }
    if (job) job._child = child
    let out = ''
    let err = ''
    let buf = ''
    let timer = null
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch {}
        reject(new Error(`命令超时：${cmd}`))
      }, timeoutMs)
    }
    const feed = (chunk) => {
      buf += chunk.toString('utf8')
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() || ''
      for (const line of lines) if (line && onLine) onLine(line)
    }
    child.stdout.on('data', (d) => { out += d.toString('utf8'); feed(d) })
    // 训练会跑很久，stderr 只保留尾部用于报错，避免内存一直涨。
    child.stderr.on('data', (d) => { err = (err + d.toString('utf8')).slice(-200000) })
    child.on('error', (error) => { if (timer) clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (buf && onLine) onLine(buf)
      if (job && job.cancelled) reject(new Error('已取消'))
      else if (code === 0) resolve({ stdout: out, stderr: err })
      else reject(new Error(`${cmd} 退出码 ${code}：${(err || out).slice(-1200)}`))
    })
  })
}

export function findPython(settings) {
  const candidates = []
  if (settings.systemPython) candidates.push({ cmd: settings.systemPython, args: [] })
  if (IS_WIN) {
    for (const v of ['3.12', '3.11', '3.10']) candidates.push({ cmd: 'py', args: [`-${v}`] })
    candidates.push({ cmd: 'python', args: [] })
  } else {
    for (const v of ['python3.12', 'python3.11', 'python3.10', 'python3', 'python']) candidates.push({ cmd: v, args: [] })
  }
  for (const item of candidates) {
    const r = runSync(item.cmd, [...item.args, '-c', 'import sys;print("%d.%d" % sys.version_info[:2])'], 6000)
    if (r.status === 0) {
      const version = String(r.stdout || '').trim()
      const [maj, min] = version.split('.').map(Number)
      if (maj === 3 && min >= 10 && min <= 12) return { ...item, version }
    }
  }
  return null
}

function pythonModules(python, modules) {
  const code = `import importlib.util as u,json,sys; mods=${JSON.stringify(modules)}; missing=[m for m in mods if u.find_spec(m) is None]; print(json.dumps(missing))`
  const r = runSync(python, ['-c', code], 20000)
  if (r.status !== 0) return { ok: false, missing: modules, error: (r.stderr || '').slice(-400) }
  try {
    const missing = JSON.parse(String(r.stdout).trim() || '[]')
    return { ok: missing.length === 0, missing }
  } catch {
    return { ok: false, missing: modules, error: 'module probe failed' }
  }
}

export function probeDevice(python) {
  if (!python || !existsSync(python)) return { device: 'cpu', gpu: '', available: false }
  const code = 'import torch,json; print(json.dumps({"cuda":torch.cuda.is_available(),"name":torch.cuda.get_device_name(0) if torch.cuda.is_available() else ""}))'
  const r = runSync(python, ['-c', code], 30000)
  if (r.status !== 0) return { device: 'cpu', gpu: '', available: false, error: (r.stderr || '').slice(-300) }
  try {
    const d = JSON.parse(String(r.stdout).trim())
    return { device: d.cuda ? 'cuda' : 'cpu', gpu: d.name || '', available: true }
  } catch {
    return { device: 'cpu', gpu: '', available: false }
  }
}

function hfWhisperDir() {
  const base = process.env.HF_HOME || process.env.TRANSFORMERS_CACHE || join(homedir(), '.cache', 'huggingface', 'hub')
  return join(base, 'models--openai--whisper-base')
}

export function checkDependencies(settings, { refresh = false } = {}) {
  const key = keyOf(settings)
  if (!refresh && cache.value && cache.key === key && Date.now() - cache.at < 15000) return cache.value
  const items = []
  const push = (id, label, ok, detail, opts = {}) => items.push({
    id, label, ok: Boolean(ok), required: opts.required !== false,
    detail: detail || '', action: opts.action || '', kind: opts.kind || '',
  })

  const boot = findPython(settings)
  push('python', '系统 Python（3.10+）', Boolean(boot), boot ? `${boot.cmd} ${boot.args.join(' ')} · ${boot.version}` : '未找到 Python 3.10+', { kind: 'system' })

  const rvcPythonOk = settings.pythonPath && existsSync(settings.pythonPath)
  const rvcMods = rvcPythonOk ? pythonModules(settings.pythonPath, REQUIRED_MODULES_RVC) : { ok: false, missing: REQUIRED_MODULES_RVC }
  push('rvc-env', 'RVC Python 环境', rvcMods.ok, rvcMods.ok ? settings.pythonPath : `缺少：${(rvcMods.missing || []).join(', ') || settings.pythonPath}`, { action: 'rvc-env' })

  const rvcCode = existsSync(join(settings.rvcDir, 'infer', 'vc', 'modules.py')) && existsSync(join(settings.rvcDir, 'infer', 'rmvpe.py'))
  push('rvc-code', 'RVC 推理代码', rvcCode, rvcCode ? settings.rvcDir : '缺少 infer/vc/modules.py 或 infer/rmvpe.py', { action: 'rvc-code' })

  const rmvpe = join(settings.rvcDir, 'assets', 'rmvpe', 'rmvpe.pt')
  const hubert = join(settings.rvcDir, 'assets', 'hubert_base', 'pytorch_model.bin')
  push('rvc-assets', 'RVC 音高/内容模型', existsSync(rmvpe) && existsSync(hubert),
    existsSync(rmvpe) && existsSync(hubert) ? 'RMVPE + HuBERT 已就绪' : '缺少 rmvpe.pt 或 hubert_base', { action: 'rvc-assets' })

  // 训练是可选的：缺少训练代码 / 底模 / TensorBoard 不影响分析与生成。
  const trainCode = existsSync(join(settings.rvcDir, 'train', 'train.py')) && existsSync(join(settings.rvcDir, 'train', 'train_index.py'))
  push('rvc-train', 'RVC 训练代码', trainCode, trainCode ? join(settings.rvcDir, 'train') : '缺少 train/train.py（环境准备会自动复制）', { action: 'rvc-train', required: false })

  const trainMods = rvcPythonOk ? pythonModules(settings.pythonPath, REQUIRED_MODULES_TRAIN) : { ok: false, missing: REQUIRED_MODULES_TRAIN }
  push('rvc-train-deps', 'RVC 训练依赖（TensorBoard / scikit-learn）', trainMods.ok,
    trainMods.ok ? '训练依赖已安装' : `缺少：${(trainMods.missing || []).join(', ') || 'tensorboard, scikit-learn'}`, { action: 'rvc-train-deps', required: false })

  const pretrainG = join(settings.rvcDir, 'assets', 'pretrained_v2', 'f0G48k.pth')
  const pretrainD = join(settings.rvcDir, 'assets', 'pretrained_v2', 'f0D48k.pth')
  const pretrainOk = existsSync(pretrainG) && existsSync(pretrainD)
  push('rvc-train-assets', 'RVC 训练底模（48k + f0）', pretrainOk,
    pretrainOk ? 'f0G48k / f0D48k 已就绪' : '缺少 f0G48k.pth 或 f0D48k.pth（约 208 MB）', { action: 'rvc-train-assets', required: false })

  // 音色模型是用户数据，不是运行环境：环境安装阶段不校验，制作台选音色时再处理。

  const ffmpegOk = settings.ffmpeg && (settings.ffmpeg.includes('/') || settings.ffmpeg.includes('\\')
    ? existsSync(settings.ffmpeg) : commandExists(settings.ffmpeg))
  push('ffmpeg', 'ffmpeg', ffmpegOk, ffmpegOk ? settings.ffmpeg : '未找到 ffmpeg', { action: 'ffmpeg' })

  const sepExeOk = settings.separatorExe && existsSync(settings.separatorExe)
  const sepCkpt = settings.separatorModelDir && existsSync(join(settings.separatorModelDir, `${SEP_MODEL}.ckpt`))
  const sepYaml = settings.separatorModelDir && existsSync(join(settings.separatorModelDir, `${SEP_MODEL}.yaml`))
  push('separator', '人声分离环境', sepExeOk && sepCkpt && sepYaml, sepExeOk && sepCkpt && sepYaml ? settings.separatorModelDir : !sepExeOk ? '缺少 audio-separator' : '缺少分离模型', { action: 'separator' })

  const soulxPythonOk = settings.soulxPython && existsSync(settings.soulxPython)
  const soulxMods = soulxPythonOk ? pythonModules(settings.soulxPython, REQUIRED_MODULES_SOULX) : { ok: false, missing: REQUIRED_MODULES_SOULX }
  push('soulx-env', 'SoulX Python 环境', soulxMods.ok, soulxMods.ok ? settings.soulxPython : `缺少：${(soulxMods.missing || []).join(', ') || settings.soulxPython}`, { action: 'soulx-env' })

  const soulxCode = existsSync(join(settings.soulxDir, 'soulxsinger', 'models', 'soulxsinger_svc.py')) && existsSync(settings.soulxConfig)
  push('soulx-code', 'SoulX 推理代码', soulxCode, soulxCode ? settings.soulxDir : '缺少 soulxsinger 或 config', { action: 'soulx-code' })

  push('soulx-model', 'SoulX SVC 模型', existsSync(settings.soulxModel), existsSync(settings.soulxModel) ? settings.soulxModel : '缺少 model-svc.pt（约 2.6 GB）', { action: 'soulx-model' })

  const whisper = existsSync(hfWhisperDir())
  push('soulx-whisper', 'Whisper base（SoulX 需要）', whisper, whisper ? '已缓存' : '首次运行会下载约 150 MB', { action: 'soulx-whisper' })

  const ready = items.every((x) => !x.required || x.ok)
  const rvcDevice = rvcPythonOk ? probeDevice(settings.pythonPath) : { device: 'cpu', gpu: '' }
  const soulxDevice = soulxPythonOk ? probeDevice(settings.soulxPython) : { device: 'cpu', gpu: '' }
  const value = { ready, items, missing: items.filter((x) => x.required && !x.ok), boot, devices: { rvc: rvcDevice, soulx: soulxDevice } }
  cache = { at: Date.now(), key, value }
  return value
}

/**
 * 需要用户手动下载 / 可以断点续传的文件清单。
 * 目标路径和自动安装使用同一份路径，用户放好后「重新检查」即可。
 */
export function downloadManifest(settings) {
  const entries = []
  const add = (id, category, label, target, urls, size = 0) => {
    let present = false
    let partial = 0
    try { present = existsSync(target) && (!size || statSync(target).size === size) } catch {}
    try { partial = statSync(`${target}.part`).size } catch {}
    entries.push({ id, category, label, target, urls, size, present, partial })
  }
  add('rmvpe', 'RVC', 'RMVPE 音高模型', join(settings.rvcDir, 'assets', 'rmvpe', 'rmvpe.pt'),
    [`${HF.rvc}/rmvpe.pt`, `${HF.rvcMirror}/rmvpe.pt`], 181184272)
  for (const name of ['config.json', 'preprocessor_config.json', 'pytorch_model.bin']) {
    add(`hubert-${name}`, 'RVC', `HuBERT ${name}`, join(settings.rvcDir, 'assets', 'hubert_base', name),
      [`${HF.rvc}/hubert_base/${name}`, `${HF.rvcMirror}/hubert_base/${name}`])
  }
  add('pretrain-G', 'RVC 训练', 'f0G48k.pth（生成器底模）', join(settings.rvcDir, 'assets', 'pretrained_v2', 'f0G48k.pth'),
    [`${HF.rvc}/pretrained_v2/f0G48k.pth`, `${HF.rvcMirror}/pretrained_v2/f0G48k.pth`], 75465569)
  add('pretrain-D', 'RVC 训练', 'f0D48k.pth（判别器底模）', join(settings.rvcDir, 'assets', 'pretrained_v2', 'f0D48k.pth'),
    [`${HF.rvc}/pretrained_v2/f0D48k.pth`, `${HF.rvcMirror}/pretrained_v2/f0D48k.pth`], 142875703)
  if (settings.soulxModel) {
    add('soulx-model', 'SoulX', 'model-svc.pt（SoulX 模型）', settings.soulxModel,
      [`${HF.soulx}/model-svc.pt`, `${HF.soulxMirror}/model-svc.pt`], 2793965154)
  }
  if (settings.separatorModelDir) {
    add('sep-ckpt', '人声分离', `${SEP_MODEL}.ckpt`, join(settings.separatorModelDir, `${SEP_MODEL}.ckpt`), [
      `https://hf-mirror.com/Politrees/UVR_resources/resolve/main/models/Roformer/BandSplit/${SEP_MODEL}.ckpt`,
      `https://huggingface.co/Politrees/UVR_resources/resolve/main/models/Roformer/BandSplit/${SEP_MODEL}.ckpt`,
      `https://github.com/nomadkaraoke/python-audio-separator/releases/download/model-configs/${SEP_MODEL}.ckpt`,
    ], 0)
    add('sep-yaml', '人声分离', `${SEP_MODEL}.yaml`, join(settings.separatorModelDir, `${SEP_MODEL}.yaml`), [
      `https://github.com/nomadkaraoke/python-audio-separator/releases/download/model-configs/${SEP_MODEL}.yaml`,
    ], 0)
  }
  return entries
}

function proxyEnv(settings) {
  if (!settings.proxy) return {}
  return { HTTP_PROXY: settings.proxy, HTTPS_PROXY: settings.proxy, http_proxy: settings.proxy, https_proxy: settings.proxy }
}

function progressAdapter(report) {
  return (stage, value, message) => {
    try { report?.(stage, value, message) } catch {}
  }
}

async function download(boot, urls, out, { size = 0, sha = '', report, job, proxy = '' } = {}) {
  ensureDir(dirname(out))
  if (existsSync(out) && (!size || statSync(out).size === size)) return out
  const script = join(boot.pluginRoot, 'engine', 'download.py')
  const args = [script, '--out', out]
  if (proxy) args.push('--proxy', proxy)
  if (size) args.push('--size', String(size))
  if (sha) args.push('--sha256', sha)
  args.push(...urls)
  await run(boot.cmd, [...boot.args, ...args], {
    job,
    timeoutMs: 2 * 60 * 60_000,
    onLine: (line) => {
      const m = /^PROGRESS\s+(\d+)\s+(\d+)/.exec(line)
      if (m && Number(m[2])) report?.('下载', Math.min(0.98, Number(m[1]) / Number(m[2])), `${out.split(/[\\/]/).pop()} ${Math.round(Number(m[1]) / 1048576)}/${Math.round(Number(m[2]) / 1048576)} MB`)
      else if (/^(DONE|SKIP|ERROR)/.test(line)) report?.('下载', 1, line)
    },
  })
  return out
}

async function ensureVenv(boot, venvDir, report) {
  const py = venvPython(venvDir)
  if (existsSync(py)) return py
  report?.('创建环境', 0.01, venvDir)
  await run(boot.cmd, [...boot.args, '-m', 'venv', venvDir], { timeoutMs: 10 * 60_000 })
  if (!existsSync(py)) throw new Error(`venv 创建失败：${venvDir}`)
  await run(py, ['-m', 'pip', 'install', '--upgrade', 'pip'], { timeoutMs: 10 * 60_000 })
  return py
}

function hasNvidia() {
  return commandExists('nvidia-smi')
}

async function installTorch(py, { version, report, settings }) {
  const cuda = hasNvidia()
  const base = ['-m', 'pip', 'install', '--no-cache-dir', `torch==${version}`, `torchaudio==${version}`]
  if (cuda) {
    report?.('安装 PyTorch', 0.05, `检测到 NVIDIA，尝试 CUDA 轮子（${version}）`)
    try {
      await run(py, [...base, '--index-url', 'https://download.pytorch.org/whl/cu121'], { timeoutMs: 60 * 60_000, env: proxyEnv(settings) })
      return 'cuda'
    } catch {
      report?.('安装 PyTorch', 0.08, 'CUDA 轮子失败，回退 CPU')
    }
  }
  report?.('安装 PyTorch', 0.05, `安装 CPU 轮子（${version}）`)
  await run(py, base, { timeoutMs: 60 * 60_000, env: proxyEnv(settings) })
  return 'cpu'
}

async function pipReq(py, reqFile, report, settings) {
  report?.('安装依赖', 0.1, reqFile.split(/[\\/]/).pop())
  await run(py, ['-m', 'pip', 'install', '--no-cache-dir', '-r', reqFile], { timeoutMs: 60 * 60_000, env: proxyEnv(settings) })
}

export async function setupAll(settings, pluginRoot, { report, job } = {}) {
  const rep = progressAdapter(report)
  const bootPython = findPython(settings)
  if (!bootPython) throw new Error('未找到 Python 3.10+，请先安装 Python 或设置 systemPython')
  const boot = { ...bootPython, python: bootPython.cmd, args: bootPython.args, pluginRoot }
  const patch = {}
  rep('检测环境', 0.01, `${boot.cmd} ${boot.version}`)

  const managed = settings.mode === 'managed'
  const rvcDir = settings.rvcDir
  const soulxDir = settings.soulxDir
  if (!existsSync(join(rvcDir, 'infer', 'vc', 'modules.py'))) {
    rep('安装 RVC 代码', 0.02, '从插件 vendor 复制')
    cpSync(join(pluginRoot, 'vendor', 'rvc'), rvcDir, { recursive: true })
  }
  // 训练代码单独补齐：老的 managed 安装里只有推理代码。
  if (!existsSync(join(rvcDir, 'train', 'train.py'))) {
    rep('安装 RVC 训练代码', 0.025, '从插件 vendor 复制 train/')
    cpSync(join(pluginRoot, 'vendor', 'rvc', 'train'), join(rvcDir, 'train'), { recursive: true })
  }
  if (existsSync(join(pluginRoot, 'vendor', 'rvc', 'tools', 'multispeaker.py'))
    && !existsSync(join(rvcDir, 'tools', 'multispeaker.py'))) {
    ensureDir(join(rvcDir, 'tools'))
    cpSync(join(pluginRoot, 'vendor', 'rvc', 'tools', 'multispeaker.py'), join(rvcDir, 'tools', 'multispeaker.py'))
  }
  if (!existsSync(join(soulxDir, 'soulxsinger', 'models', 'soulxsinger_svc.py'))) {
    rep('安装 SoulX 代码', 0.03, '从插件 vendor 复制')
    cpSync(join(pluginRoot, 'vendor', 'soulx'), soulxDir, { recursive: true })
  }

  const rvcVenv = settings.pythonPath ? join(settings.pythonPath, '..', '..') : join(settings.runtimeRoot, 'venv-rvc')
  const soulxVenv = settings.soulxPython ? join(settings.soulxPython, '..', '..') : join(settings.runtimeRoot, 'venv-soulx')
  const rvcPython = await ensureVenv(boot, rvcVenv, rep)
  const soulxPython = await ensureVenv(boot, soulxVenv, rep)
  const rvcMods = pythonModules(rvcPython, REQUIRED_MODULES_RVC)
  if (!rvcMods.ok) {
    rep('安装 PyTorch', 0.05, 'RVC')
    await installTorch(rvcPython, { version: '2.4.1', report: rep, settings })
    await pipReq(rvcPython, join(pluginRoot, 'engine', 'requirements-rvc.txt'), rep, settings)
  } else {
    rep('安装 PyTorch', 0.05, 'RVC 依赖已存在，跳过')
  }
  const trainMods = pythonModules(rvcPython, REQUIRED_MODULES_TRAIN)
  if (!trainMods.ok) {
    rep('安装训练依赖', 0.07, `tensorboard / scikit-learn（缺少 ${(trainMods.missing || []).join(', ')}）`)
    await run(rvcPython, ['-m', 'pip', 'install', '--no-cache-dir', 'tensorboard>=2.9', 'scikit-learn>=1.0'], { timeoutMs: 30 * 60_000, env: proxyEnv(settings) })
  }
  const soulxMods = pythonModules(soulxPython, REQUIRED_MODULES_SOULX)
  if (!soulxMods.ok) {
    rep('安装 PyTorch', 0.1, 'SoulX')
    await installTorch(soulxPython, { version: '2.2.0', report: rep, settings })
    await pipReq(soulxPython, join(pluginRoot, 'engine', 'requirements-soulx.txt'), rep, settings)
  } else {
    rep('安装 PyTorch', 0.1, 'SoulX 依赖已存在，跳过')
  }

  rep('下载 RVC 资源', 0.15, 'RMVPE')
  await download(boot, [`${HF.rvc}/rmvpe.pt`, `${HF.rvcMirror}/rmvpe.pt`], join(rvcDir, 'assets', 'rmvpe', 'rmvpe.pt'), { size: 181184272, report: rep, job, proxy: settings.proxy })
  for (const name of ['config.json', 'preprocessor_config.json', 'pytorch_model.bin']) {
    rep('下载 RVC 资源', 0.2, name)
    await download(boot, [`${HF.rvc}/hubert_base/${name}`, `${HF.rvcMirror}/hubert_base/${name}`], join(rvcDir, 'assets', 'hubert_base', name), { report: rep, job, proxy: settings.proxy })
  }

  // RVC 训练底模（48k + f0）：只在做训练时才用得到，做成可选依赖。
  for (const [name, size] of [['f0G48k.pth', 75465569], ['f0D48k.pth', 142875703]]) {
    rep('下载 RVC 训练底模', 0.24, name)
    await download(boot, [`${HF.rvc}/pretrained_v2/${name}`, `${HF.rvcMirror}/pretrained_v2/${name}`],
      join(rvcDir, 'assets', 'pretrained_v2', name), { size, report: rep, job, proxy: settings.proxy })
  }

  rep('下载 SoulX 模型', 0.3, 'model-svc.pt（约 2.6 GB）')
  await download(boot, [`${HF.soulx}/model-svc.pt`, `${HF.soulxMirror}/model-svc.pt`], settings.soulxModel, { size: 2793965154, report: rep, job, proxy: settings.proxy })

  const existingSep = settings.separatorExe && existsSync(settings.separatorExe)
    && settings.separatorModelDir && existsSync(join(settings.separatorModelDir, `${SEP_MODEL}.ckpt`))
    && existsSync(join(settings.separatorModelDir, `${SEP_MODEL}.yaml`))
  if (!existingSep) {
    rep('下载分离模型', 0.55, `${SEP_MODEL}.ckpt`)
    await download(boot, [
      `https://hf-mirror.com/Politrees/UVR_resources/resolve/main/models/Roformer/BandSplit/${SEP_MODEL}.ckpt`,
      `https://huggingface.co/Politrees/UVR_resources/resolve/main/models/Roformer/BandSplit/${SEP_MODEL}.ckpt`,
      `https://github.com/nomadkaraoke/python-audio-separator/releases/download/model-configs/${SEP_MODEL}.ckpt`,
    ], join(settings.separatorModelDir, `${SEP_MODEL}.ckpt`), { size: 0, sha: SEP_CKPT_SHA, report: rep, job, proxy: settings.proxy })
    await download(boot, [`https://github.com/nomadkaraoke/python-audio-separator/releases/download/model-configs/${SEP_MODEL}.yaml`], join(settings.separatorModelDir, `${SEP_MODEL}.yaml`), { sha: SEP_YAML_SHA, report: rep, job, proxy: settings.proxy })

    rep('安装分离器', 0.65, 'audio-separator')
    const sepVenv = join(settings.runtimeRoot, 'venv-separator')
    const sepPy = await ensureVenv(boot, sepVenv, rep)
    await run(sepPy, ['-m', 'pip', 'install', '--no-cache-dir', 'audio-separator'], { timeoutMs: 60 * 60_000, env: proxyEnv(settings) })
    patch.separatorExe = venvBin(sepVenv, 'audio-separator')
    patch.separatorModelDir = settings.separatorModelDir
  }

  const ffOk = settings.ffmpeg && (settings.ffmpeg.includes('/') || settings.ffmpeg.includes('\\')
    ? existsSync(settings.ffmpeg) : commandExists(settings.ffmpeg))
  if (!ffOk) {
    rep('准备 ffmpeg', 0.78, 'imageio-ffmpeg')
    await run(rvcPython, ['-m', 'pip', 'install', '--no-cache-dir', 'imageio-ffmpeg'], { timeoutMs: 10 * 60_000, env: proxyEnv(settings) })
    const ff = await run(rvcPython, ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'], { timeoutMs: 30_000 })
    patch.ffmpeg = String(ff.stdout || '').trim()
  }

  const whisperDir = process.env.HF_HOME || join(homedir(), '.cache', 'huggingface', 'hub')
  if (!existsSync(join(whisperDir, 'models--openai--whisper-base'))) {
    rep('准备 Whisper', 0.85, 'openai/whisper-base')
    await run(soulxPython, ['-c', 'from transformers import WhisperFeatureExtractor,WhisperModel; WhisperFeatureExtractor.from_pretrained("openai/whisper-base"); WhisperModel.from_pretrained("openai/whisper-base")'], { timeoutMs: 30 * 60_000, env: proxyEnv(settings) })
  }

  rep('完成', 1, '环境已准备')
  return patch
}

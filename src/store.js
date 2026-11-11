import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

export const IS_WIN = process.platform === 'win32'
export const PYTHON_EXE = IS_WIN ? 'python.exe' : 'python'
export const BIN_DIR = IS_WIN ? 'Scripts' : 'bin'

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function dataDir(...parts) {
  const base = process.env.SINGING_STUDIO_DATA_DIR || join(dshHome(), 'plugins-data', 'singing-studio')
  return join(base, ...parts)
}

export function ensureDir(p) {
  mkdirSync(p, { recursive: true })
  return p
}

export function readJson(file, fallback) {
  try {
    let text = readFileSync(file, 'utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    return JSON.parse(text)
  } catch {
    return typeof fallback === 'function' ? fallback() : fallback
  }
}

export function writeJson(file, value) {
  ensureDir(dirname(file))
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

export function sha1(value, len = 16) {
  return createHash('sha1').update(value).digest('hex').slice(0, len)
}

export function isInside(root, target) {
  const r = resolve(root) + sep
  const t = resolve(target)
  return t === resolve(root) || t.startsWith(r)
}

export function exists(p) {
  return existsSync(p)
}

export function venvPython(venvDir) {
  return join(venvDir, BIN_DIR, PYTHON_EXE)
}

export function venvBin(venvDir, name) {
  return join(venvDir, BIN_DIR, IS_WIN ? `${name}.exe` : name)
}

/**
 * Legacy project mode keeps the existing virtual_singer layout.
 * Managed mode puts code, venvs, models and ffmpeg under the plugin data dir.
 */
export function defaultSettings(projectRoot = '', runtimeRoot = '') {
  const root = projectRoot || ''
  const managed = !root
  const runtime = runtimeRoot || dataDir('runtime')
  const rvcDir = managed ? join(runtime, 'rvc') : join(root, 'third_party', 'rvc')
  const rvcVenv = managed ? join(runtime, 'venv-rvc') : join(root, '.venv-rvc')
  const soulxDir = managed ? join(runtime, 'soulx') : join(root, 'third_party', 'SoulX-Singer')
  const soulxVenv = managed ? join(runtime, 'venv-soulx') : join(root, '.venv-soulx')
  const separatorVenv = join(runtime, 'venv-separator')
  return {
    mode: managed ? 'managed' : 'existing',
    projectRoot: root,
    runtimeRoot: runtime,
    systemPython: '',
    proxy: '',
    uvPath: '',
    pythonPath: venvPython(rvcVenv),
    rvcDir,
    modelsDir: managed ? join(runtime, 'models', 'rvc') : join(rvcDir, 'assets', 'weights'),
    ffmpeg: 'ffmpeg',
    ffprobe: 'ffprobe',
    separatorExe: managed ? venvBin(separatorVenv, 'audio-separator') : '',
    separatorModelDir: managed ? join(runtime, 'models', 'separator') : '',
    separatorModel: 'model_bs_roformer_ep_317_sdr_12.9755.ckpt',
    soulxPython: venvPython(soulxVenv),
    soulxDir,
    soulxModel: managed ? join(runtime, 'models', 'soulx', 'model-svc.pt') : join(root, 'model', 'SoulX-Singer', 'model-svc.pt'),
    soulxConfig: join(soulxDir, 'soulxsinger', 'config', 'soulxsinger.yaml'),
    soulxDevice: 'auto',
    soulxSteps: 16,
    soulxCfg: 3.0,
    soulxPromptSeconds: 12,
    soulxPromptWav: '',
    autoWarmup: false,
    targetCoverage: 0.95,
    maxOctaves: 2,
    maxCandidates: 4,
    protect: 0.25,
    rmsMixRate: 0.25,
    indexRate: 0,
    crossfadeMs: 50,
    fillGap: 0.5,
    phraseGap: 0.25,
    sectionGap: 1.2,
    minPhrase: 0.6,
    topDb: 14,
    maxUploadMB: 200,
    neteaseCookie: '',
  }
}

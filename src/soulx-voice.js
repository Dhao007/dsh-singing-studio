import { existsSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'

import { run } from './deps.js'
import { dataDir, readJson, sha1, writeJson } from './store.js'
import { resolveModelInput, validateProfile } from './model-inspect.js'

const AUDIO_EXTS = new Set(['.wav', '.flac', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.wma'])

function slug(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

/**
 * 用一段参考音频创建 SoulX 零样本音色。
 * 只需要参考音频和 RMVPE：从音频统计音域 Profile，不创建 / 不加载 RVC 权重。
 */
export async function createSoulxVoice(settings, pluginRoot, opts = {}) {
  const rawPrompt = String(opts.promptWav || settings.soulxPromptWav || '').trim()
  if (!rawPrompt) return { ok: false, message: '请先填写参考音频路径，或在制作台设置里配置默认参考音频' }
  const promptWav = resolveModelInput(settings, pluginRoot, rawPrompt)
  if (!existsSync(promptWav) || !statSync(promptWav).isFile()) {
    return { ok: false, message: `参考音频不存在：${promptWav}` }
  }
  const ext = extname(promptWav).toLowerCase()
  if (!AUDIO_EXTS.has(ext)) return { ok: false, message: `不支持的参考音频格式：${ext || '(无)'}` }

  const python = String(settings.pythonPath || '')
  if (!python || !existsSync(python)) {
    return { ok: false, message: 'RVC Python 环境还没准备好，先在「环境安装」完成准备' }
  }
  const rmvpe = join(settings.rvcDir || '', 'assets', 'rmvpe', 'rmvpe.pt')
  if (!existsSync(rmvpe)) {
    return { ok: false, message: '缺少 RMVPE 音高模型，先在「环境安装」完成准备' }
  }
  const script = join(pluginRoot, 'engine', 'build_profile.py')
  if (!existsSync(script)) return { ok: false, message: '缺少 build_profile.py，插件文件不完整' }

  const label = String(opts.label || '').trim() || basename(promptWav, ext)
  const base = slug(opts.name || basename(promptWav, ext)) || `soulx-${sha1(promptWav, 8)}`
  let id = base
  let n = 2
  const profilesDir = dataDir('profiles')
  while (existsSync(join(profilesDir, `${id}.json`)) || (settings.modelsDir && existsSync(join(settings.modelsDir, `${id}.pth`)))) {
    id = `${base}-${n++}`
  }
  const profilePath = join(profilesDir, `${id}.json`)
  try {
    await run(python, [
      script,
      '--dataset', promptWav,
      '--name', id,
      '--label', label,
      '--model', '',
      '--source', promptWav,
      '--out', profilePath,
      '--rvc-dir', settings.rvcDir,
      '--max-seconds', '30',
    ], { timeoutMs: 5 * 60_000 })
  } catch (error) {
    return { ok: false, message: String(error?.message || error) }
  }
  const rawProfile = readJson(profilePath, null)
  if (!rawProfile) return { ok: false, message: 'Profile 生成失败：没有写出有效 JSON' }
  const profile = {
    ...rawProfile,
    id,
    label,
    model: '',
    kind: 'soulx',
    promptWav,
    source: promptWav,
    notes: 'SoulX 零样本：从参考音频统计音域，无需 RVC 权重。',
  }
  writeJson(profilePath, profile)
  const validation = validateProfile(profile, {
    modelId: id,
    projectRoot: settings.projectRoot || pluginRoot,
  })
  if (!validation.ok) {
    return { ok: false, message: validation.issues[0] || '生成的 Profile 未通过校验', profile, profilePath }
  }
  return {
    ok: true,
    voiceId: id,
    profilePath,
    promptWav,
    profile,
    validation,
  }
}

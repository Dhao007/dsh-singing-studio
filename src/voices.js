import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { dataDir } from './store.js'
import { baseIdOf, inspectModelFile, validateProfile } from './model-inspect.js'


function readProfileDir(dir, out) {
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      try {
        const p = JSON.parse(readFileSync(join(dir, name), 'utf8'))
        if (p && p.id) out.set(String(p.id), p)
      } catch {}
    }
  } catch {}
}

function readProfiles(pluginRoot) {
  const out = new Map()
  // 插件自带 profile 先读，插件数据目录里的（训练自动生成）后读并覆盖。
  readProfileDir(join(pluginRoot, 'profiles'), out)
  readProfileDir(dataDir('profiles'), out)
  return out
}


export function listVoices(settings, pluginRoot) {
  const profiles = readProfiles(pluginRoot)
  const dir = settings.modelsDir
  const groups = new Map()
  let names = []
  try {
    names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.pth'))
  } catch {
    names = []
  }
  for (const name of names) {
    const full = join(dir, name)
    const base = baseIdOf(name)
    let st
    try { st = statSync(full) } catch { continue }
    const prev = groups.get(base)
    const exact = name === `${base}.pth`
    if (!prev || exact || (!prev.exact && st.mtimeMs > prev.mtimeMs)) {
      groups.set(base, { base, file: full, name, exact, mtimeMs: st.mtimeMs, size: st.size })
    }
  }
  const voices = []
  for (const g of groups.values()) {
    const profile = profiles.get(g.base) || null
    const format = inspectModelFile(g.file)
    const profileValidation = profile
      ? validateProfile(profile, {
        modelId: g.base,
        modelFileName: g.name,
        projectRoot: settings.projectRoot || pluginRoot,
      })
      : { ok: false, issues: ['缺少 Profile'], warnings: [] }
    const usable = Boolean(profile && profileValidation.ok && format.ok)
    voices.push({
      id: g.base,
      label: profile?.label || g.base,
      file: g.file,
      fileName: g.name,
      size: g.size,
      calibrated: Boolean(profile),
      usable,
      profile,
      format,
      profileValidation,
      kind: 'rvc',
      range: usable ? { low: profile.p5, high: profile.p95, p1: profile.p1, p99: profile.p99 } : null,
    })
  }
  // SoulX 零样本音色：只有 Profile + 参考音频，没有 RVC 权重。
  for (const [id, profile] of profiles) {
    if (groups.has(id)) continue
    if (profile?.kind !== 'soulx') continue
    const profileValidation = validateProfile(profile, {
      modelId: id,
      projectRoot: settings.projectRoot || pluginRoot,
    })
    voices.push({
      id,
      label: profile.label || id,
      file: '',
      fileName: '',
      size: 0,
      calibrated: true,
      usable: profileValidation.ok,
      profile,
      format: { ok: true, kind: 'soulx', message: 'SoulX 零样本音色（无 RVC 权重）', issues: [], warnings: [] },
      profileValidation,
      kind: 'soulx',
      promptWav: String(profile.promptWav || ''),
      range: profileValidation.ok ? { low: profile.p5, high: profile.p95, p1: profile.p1, p99: profile.p99 } : null,
    })
  }
  voices.sort((a, b) => (Number(b.usable) - Number(a.usable)) || a.label.localeCompare(b.label, 'zh'))
  return voices
}

export function resolveVoice(settings, pluginRoot, voiceId, opts = {}) {
  const all = listVoices(settings, pluginRoot)
  const found = all.find((v) => v.id === voiceId)
  if (!found) throw new Error(`音色模型不存在：${voiceId}`)
  if (!found.usable) {
    const reason = found.profileValidation?.issues?.[0]
      || found.format?.issues?.[0]
      || (found.profile ? '音域 Profile 不可用' : '缺少音域 Profile')
    throw new Error(`音色模型不可用（${voiceId}）：${reason}`)
  }
  if (found.kind === 'soulx' && opts.backend && opts.backend !== 'soulx') {
    throw new Error(`「${found.label}」是 SoulX 零样本音色，不能用于 RVC；请换一个 RVC 音色，或把后端切到 SoulX`)
  }
  return found
}

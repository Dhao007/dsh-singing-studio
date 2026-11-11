import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

import { dataDir } from './store.js'


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

export function baseIdOf(file) {
  return basename(file, '.pth').replace(/_e\d+_s\d+$/, '')
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
    voices.push({
      id: g.base,
      label: profile?.label || g.base,
      file: g.file,
      fileName: g.name,
      size: g.size,
      calibrated: Boolean(profile),
      profile,
      range: profile ? { low: profile.p5, high: profile.p95, p1: profile.p1, p99: profile.p99 } : null,
    })
  }
  voices.sort((a, b) => (Number(b.calibrated) - Number(a.calibrated)) || a.label.localeCompare(b.label, 'zh'))
  return voices
}

export function resolveVoice(settings, pluginRoot, voiceId) {
  const all = listVoices(settings, pluginRoot)
  const found = all.find((v) => v.id === voiceId)
  if (!found) throw new Error(`音色模型不存在或未校准：${voiceId}`)
  if (!found.calibrated) throw new Error(`音色模型还没有音域 profile：${voiceId}`)
  return found
}

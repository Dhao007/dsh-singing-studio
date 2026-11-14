import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { dataDir, readJson } from './store.js'

const AUDITION_RE = /^([A-Za-z0-9][A-Za-z0-9_-]{0,39})_e(\d+)_s(\d+)\.pth$/

function fitsFromHistory(rows) {
  const map = new Map()
  if (!Array.isArray(rows)) return map
  for (const row of rows) {
    if (!row) continue
    const epoch = Number(row.epoch)
    const fit = Number(row.fit)
    if (!Number.isFinite(epoch) || !Number.isFinite(fit)) continue
    map.set(epoch, fit)
  }
  return map
}

/**
 * 扫描 assets/weights 里每 N 轮导出的可试听模型，按训练拟合度排序后只取前 limit 个。
 * 拟合度优先取 logs/<名字>/plugin-state.json 的 epochFits（续训也会累积），
 * 其次从 data/training/*.json 的训练结果 history 里补齐；都没有时排到最后兜底。
 */
export function listAuditionModels(settings, { limit = 2 } = {}) {
  const weightsDir = join(settings.rvcDir, 'assets', 'weights')
  let active = {}
  try { active = readJson(dataDir('training', 'voice-epochs.json'), {}) || {} } catch {}

  const stateCache = new Map()
  const stateOf = (name) => {
    if (stateCache.has(name)) return stateCache.get(name)
    const state = readJson(join(settings.rvcDir, 'logs', name, 'plugin-state.json'), null)
    const info = { fits: new Map(), finishedAt: 0 }
    if (state) {
      const raw = state.epochFits && typeof state.epochFits === 'object' ? state.epochFits : {}
      for (const [key, value] of Object.entries(raw)) {
        const epoch = Number(key)
        const fit = Number(value)
        if (Number.isFinite(epoch) && Number.isFinite(fit)) info.fits.set(epoch, fit)
      }
      if (state.stage === '完成') {
        const stamp = Number(state.updatedAt)
        if (Number.isFinite(stamp) && stamp > 0) info.finishedAt = stamp * 1000
      }
    }
    stateCache.set(name, info)
    return info
  }

  const resultFits = new Map()
  const resultFinished = new Map()
  try {
    for (const file of readdirSync(dataDir('training'))) {
      if (file === 'voice-epochs.json' || !file.endsWith('.json')) continue
      const full = join(dataDir('training'), file)
      let mtime = 0
      try { mtime = statSync(full).mtimeMs } catch {}
      const result = readJson(full, null)
      if (!result || !result.id) continue
      if (mtime > (resultFinished.get(result.id) || 0)) resultFinished.set(result.id, mtime)
      for (const [epoch, fit] of fitsFromHistory(result.history)) {
        const key = `${result.id}:${epoch}`
        const prev = resultFits.get(key)
        if (!prev || mtime >= prev.mtime) resultFits.set(key, { fit, mtime })
      }
    }
  } catch {}

  const byKey = new Map()
  try {
    for (const file of readdirSync(weightsDir)) {
      const match = AUDITION_RE.exec(file)
      if (!match) continue
      const full = join(weightsDir, file)
      let st
      try { st = statSync(full) } catch { continue }
      const name = match[1]
      const epoch = Number(match[2])
      const key = `${name}:${epoch}`
      const prev = byKey.get(key)
      // 同一轮次可能被续训重复导出，保留更晚的那份。
      if (prev && prev.mtime > st.mtimeMs) continue
      const info = stateOf(name)
      const fit = info.fits.get(epoch) ?? resultFits.get(key)?.fit ?? null
      byKey.set(key, {
        name,
        epoch,
        step: Number(match[3]),
        path: full,
        size: st.size,
        mtime: st.mtimeMs,
        fit: fit == null ? null : Number(Number(fit).toFixed(1)),
        finishedAt: info.finishedAt || resultFinished.get(name) || 0,
        hasProfile: existsSync(join(dataDir('profiles'), `${name}.json`)),
        activeEpoch: Number(active?.[name]?.epoch ?? -1),
      })
    }
  } catch {}

  const fallbackFinished = new Map()
  for (const item of byKey.values()) {
    if (item.finishedAt) continue
    fallbackFinished.set(item.name, Math.max(fallbackFinished.get(item.name) || 0, item.mtime))
  }
  for (const item of byKey.values()) {
    if (!item.finishedAt) item.finishedAt = fallbackFinished.get(item.name) || 0
  }

  const top = Math.max(1, Math.trunc(Number(limit) || 2))
  const groups = new Map()
  for (const item of byKey.values()) {
    if (!groups.has(item.name)) groups.set(item.name, [])
    groups.get(item.name).push(item)
  }
  const fitOf = (item) => (item.fit == null ? Number.NEGATIVE_INFINITY : item.fit)
  const picked = []
  for (const [name, rows] of groups) {
    rows.sort((a, b) => {
      if (fitOf(a) !== fitOf(b)) return fitOf(b) - fitOf(a)
      return a.epoch - b.epoch
    })
    picked.push({ name, rows: rows.slice(0, top) })
  }
  // 模型名之间按各自最优拟合度排序，同分再按名字；组内保持前 N。
  picked.sort((a, b) => {
    const fitA = fitOf(a.rows[0])
    const fitB = fitOf(b.rows[0])
    if (fitA !== fitB) return fitB - fitA
    return a.name.localeCompare(b.name)
  })
  const items = picked.flatMap((group) => group.rows)
  return { items, total: byKey.size, limit: top, models: picked.length }
}

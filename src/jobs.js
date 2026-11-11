import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dataDir, readJson, writeJson } from './store.js'

function publicJob(job) {
  return {
    id: job.id,
    type: job.type,
    meta: job.meta || {},
    status: job.status,
    stage: job.stage || '',
    progress: job.progress || 0,
    message: job.message || '',
    error: job.error || '',
    createdAt: job.createdAt,
    startedAt: job.startedAt || null,
    endedAt: job.endedAt || null,
    detail: job.detail || null,
    result: job.result || null,
  }
}

// 训练 / 环境准备会派生子进程；Windows 上要连进程树一起结束。
function killChildTree(child) {
  if (!child || typeof child.kill !== 'function') return
  if (process.platform === 'win32' && child.pid) {
    try { spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true }) } catch {}
    return
  }
  try { child.kill('SIGTERM') } catch {}
}

export class Jobs {
  constructor({ onUpdate } = {}) {
    this.onUpdate = onUpdate || (() => {})
    this.map = new Map()
    this.queue = []
    this.running = null
    this.load()
  }

  load() {
    const rows = readJson(dataDir('history.json'), [])
    if (Array.isArray(rows)) {
      for (const row of rows.slice(-50)) {
        if (row && row.id) this.map.set(row.id, { ...row, _persisted: true })
      }
    }
  }

  persist() {
    const rows = [...this.map.values()]
      .filter((j) => j.status === 'done' || j.status === 'error' || j.status === 'cancelled')
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 50)
      .map(publicJob)
    try { writeJson(dataDir('history.json'), rows) } catch {}
  }

  emit(job) {
    try { this.onUpdate(publicJob(job)) } catch {}
  }

  create(type, fn, meta = {}) {
    const job = {
      id: randomUUID().replace(/-/g, '').slice(0, 16),
      type,
      meta,
      status: 'queued',
      stage: '排队',
      progress: 0,
      message: '',
      error: '',
      createdAt: Date.now(),
      result: null,
      _fn: fn,
    }
    this.map.set(job.id, job)
    this.queue.push(job)
    this.emit(job)
    this.pump()
    return job
  }

  update(job, patch) {
    Object.assign(job, patch)
    this.emit(job)
  }

  progress(job, stage, progress, message, detail) {
    job.stage = stage
    if (typeof progress === 'number' && Number.isFinite(progress)) {
      job.progress = Math.max(0, Math.min(1, progress))
    }
    if (message != null) job.message = String(message)
    if (detail !== undefined) job.detail = detail
    this.emit(job)
  }

  attach(job, child) {
    job._child = child
  }

  async pump() {
    if (this.running) return
    const job = this.queue.shift()
    if (!job) return
    this.running = job
    job.status = 'running'
    job.startedAt = Date.now()
    job.stage = '开始'
    this.emit(job)
    try {
      const result = await job._fn(job)
      job.result = result ?? null
      job.status = 'done'
      job.progress = 1
      job.stage = '完成'
    } catch (error) {
      if (job.cancelled) {
        job.status = 'cancelled'
        job.stage = '已取消'
        job.error = ''
      } else {
        job.status = 'error'
        job.error = String(error && error.message ? error.message : error)
        job.stage = '失败'
      }
    } finally {
      job.endedAt = Date.now()
      job._child = null
      this.running = null
      this.persist()
      this.emit(job)
      this.pump()
    }
  }

  get(id) {
    const job = this.map.get(id)
    return job ? publicJob(job) : null
  }

  list(limit = 20) {
    return [...this.map.values()]
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, limit)
      .map(publicJob)
  }

  cancel(id) {
    const job = this.map.get(id)
    if (!job) return false
    if (job.status === 'queued') {
      this.queue = this.queue.filter((j) => j.id !== id)
      job.status = 'cancelled'
      job.stage = '已取消'
      job.endedAt = Date.now()
      this.emit(job)
      this.persist()
      return true
    }
    if (job.status === 'running') {
      job.cancelled = true
      killChildTree(job._child)
      job.status = 'cancelled'
      job.stage = '已取消'
      job.endedAt = Date.now()
      this.emit(job)
      this.persist()
      return true
    }
    return false
  }

  dispose() {
    for (const job of this.map.values()) {
      if (job._child) killChildTree(job._child)
    }
  }
}

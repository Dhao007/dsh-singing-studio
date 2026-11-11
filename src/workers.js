import { spawn } from 'node:child_process'
import readline from 'node:readline'

/**
 * A JSONL worker process: one request at a time, model stays loaded until stop().
 * The worker sends {type:"ready"}, {type:"progress"} and {type:"result"} lines.
 */
export class WorkerClient {
  constructor({ name, python, script, args = [], cwd, env = {}, onLog }) {
    this.name = name
    this.python = python
    this.script = script
    this.args = args
    this.cwd = cwd
    this.env = env
    this.onLog = onLog || (() => {})
    this.child = null
    this.rl = null
    this.started = false
    this.starting = null
    this.seq = 0
    this.active = null
    this.chain = Promise.resolve()
    this.info = null
    this.lastError = ''
  }

  _spawn() {
    const child = spawn(this.python, [this.script, ...this.args], {
      cwd: this.cwd,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
        ...this.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    const rl = readline.createInterface({ input: child.stdout })
    this.rl = rl
    rl.on('line', (line) => this._onLine(line))
    const erl = readline.createInterface({ input: child.stderr })
    erl.on('line', (line) => {
      this.lastError = line
      try { this.onLog(line) } catch {}
    })
    child.on('error', (error) => this._failAll(error))
    child.on('exit', (code, signal) => {
      const error = new Error(`${this.name} worker 退出（${code ?? signal}）${this.lastError ? '：' + this.lastError : ''}`)
      this.started = false
      this.info = null
      this.child = null
      this._failAll(error)
    })
    return new Promise((resolve, reject) => {
      this._readyResolve = resolve
      this._readyReject = reject
      const timer = setTimeout(() => {
        reject(new Error(`${this.name} worker 启动超时`))
        try { child.kill('SIGKILL') } catch {}
      }, 15 * 60_000)
      this._readyTimer = timer
    })
  }

  _onLine(line) {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    if (msg.type === 'ready') {
      this.started = true
      this.info = msg.result || {}
      if (this._readyTimer) clearTimeout(this._readyTimer)
      this._readyResolve?.(this.info)
      this._readyResolve = null
      return
    }
    const id = msg.id
    const active = this.active
    if (!active || active.id !== id) return
    if (msg.type === 'progress') {
      try { active.onProgress?.(msg.stage || '', Number(msg.value) || 0) } catch {}
      return
    }
    if (msg.type === 'result') {
      if (active.timer) clearTimeout(active.timer)
      this.active = null
      if (msg.ok) {
        if (msg.result && msg.result.status) this.info = { ...(this.info || {}), ...msg.result.status }
        else if (msg.result && msg.result.device) this.info = { ...(this.info || {}), ...msg.result }
        active.resolve(msg.result ?? {})
      } else active.reject(new Error(msg.error || `${this.name} 任务失败`))
    }
  }

  _failAll(error) {
    if (this._readyTimer) clearTimeout(this._readyTimer)
    this._readyReject?.(error)
    this._readyResolve = null
    this._readyReject = null
    if (this.active) {
      if (this.active.timer) clearTimeout(this.active.timer)
      const active = this.active
      this.active = null
      active.reject(error)
    }
  }

  async start() {
    if (this.started) return this.info
    if (this.starting) return this.starting
    this.starting = this._spawn().finally(() => { this.starting = null })
    return this.starting
  }

  status() {
    return this.info || {}
  }

  request(op, args, { onProgress, timeoutMs = 2 * 60 * 60_000 } = {}) {
    const run = this.chain.then(() => this._request(op, args, { onProgress, timeoutMs }))
    this.chain = run.catch(() => {})
    return run
  }

  async _request(op, args, { onProgress, timeoutMs }) {
    await this.start()
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        if (this.active && this.active.id === id) {
          this.active = null
          reject(new Error(`${this.name} 任务超时`))
        }
      }, timeoutMs) : null
      this.active = { id, resolve, reject, onProgress, timer }
      try {
        this.child.stdin.write(JSON.stringify({ id, op, args }) + '\n')
      } catch (error) {
        if (timer) clearTimeout(timer)
        this.active = null
        reject(error)
      }
    })
  }

  async stop() {
    const child = this.child
    if (!child) return
    try {
      await this.request('shutdown', {}, { timeoutMs: 5000 })
    } catch {}
    try { child.kill('SIGTERM') } catch {}
    setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 3000).unref?.()
    this.child = null
    this.started = false
    this.info = null
  }

  /**
   * 立即终止正在启动或正在跑的 Worker，用于“暂停预加载”。
   * 和 stop() 不同：不等模型加载完，也不发 shutdown 请求，直接结束进程并让等待中的调用立刻失败。
   */
  kill(reason = '已取消') {
    const child = this.child
    const error = new Error(reason)
    if (this._readyTimer) clearTimeout(this._readyTimer)
    this.child = null
    this.started = false
    this.info = null
    this.starting = null
    this._readyResolve = null
    const reject = this._readyReject
    this._readyReject = null
    this._failAll(error)
    try { reject?.(error) } catch {}
    try { child?.kill('SIGKILL') } catch {}
    return error
  }
}

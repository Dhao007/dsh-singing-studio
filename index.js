import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { extname, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { Jobs } from './src/jobs.js'
import { buildPlans } from './src/plan.js'
import { placeUpload } from './src/env-upload.js'
import {
  decodeToWav, mix, probeDuration, separate, streamFile,
} from './src/engine.js'
import { WorkerClient } from './src/workers.js'
import { checkDependencies, downloadManifest, invalidateDeps, run, setupAll, syncVendorCode } from './src/deps.js'
import { searchSongs, songUrl, USER_AGENT } from './src/netease.js'
import {
  dataDir, defaultSettings, ensureDir, isInside, readJson, sha1, writeJson,
} from './src/store.js'
import { listVoices, resolveVoice } from './src/voices.js'
import { importModel, inspectModelPath } from './src/model-inspect.js'
import { buildModelProfile } from './src/model-profile.js'
import { createSoulxVoice } from './src/soulx-voice.js'
import { listAuditionModels } from './src/train-history.js'

export const name = 'singing-studio'
export const inject = ['webServer']

const PREFIX = '/singing/api'
const PLUGIN_ROOT = fileURLToPath(new URL('.', import.meta.url))
const AUDIO_EXT = new Set(['.wav', '.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wma'])
const ID_RE = /^[a-f0-9]{8,32}$/

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error(`文件太大了（最多 ${Math.round(maxBytes / 1024 / 1024)}MB）`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  const buf = await readBody(req, maxBytes)
  if (!buf.length) return {}
  return JSON.parse(buf.toString('utf8'))
}

function safeJoin(root, ...parts) {
  const p = join(root, ...parts)
  if (!isInside(root, p)) throw new Error('非法路径')
  return p
}

function sameId(value) {
  return typeof value === 'string' && ID_RE.test(value)
}

function soulxPromptPath(settings, voice) {
  const candidates = [
    String(voice?.profile?.promptWav || '').trim(),
    String(settings.soulxPromptWav || '').trim(),
  ].filter(Boolean)
  if (!candidates.length) {
    throw new Error('SoulX-SVC 缺少参考音频：请在音色 Profile 配置 promptWav，或在「制作台设置」里填默认参考音频')
  }
  const missing = []
  for (const raw of candidates) {
    const file = isAbsolute(raw) ? raw : join(settings.projectRoot, raw)
    if (existsSync(file)) return file
    missing.push(file)
  }
  throw new Error(`SoulX-SVC 参考音频不存在：${missing.join('；')}`)
}

const TRAIN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/
const TRAIN_ITEMS = ['rvc-env', 'rvc-code', 'rvc-assets', 'rvc-train', 'rvc-train-deps']

function walkAudioFiles(dir, out, depth = 0) {
  if (depth > 6 || out.length >= 5000) return
  let entries = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkAudioFiles(full, out, depth + 1)
    else if (entry.isFile() && AUDIO_EXT.has(extname(entry.name).toLowerCase())) out.push(full)
    if (out.length >= 5000) return
  }
}

function resolveUserPath(settings, raw) {
  let value = String(raw || '').trim()
  if (!value) return ''
  if (value === '~') value = homedir()
  else if (value.startsWith('~/') || value.startsWith('~\\')) value = join(homedir(), value.slice(2))
  return isAbsolute(value) ? value : join(settings.projectRoot || process.cwd(), value)
}

/** 上次训练留下的可续训状态；数据 / 参数对不上就不算可续。 */
function trainResumeInfo(settings, name, dataset, sr, version, per) {
  const expDir = join(settings.rvcDir, 'logs', name)
  const stateFile = join(expDir, 'plugin-state.json')
  if (!existsSync(stateFile)) return null
  const state = readJson(stateFile, null)
  if (!state || state.stage === 'done') return null
  if (state.dataset && dataset && String(state.dataset) !== String(dataset)) return null
  if (String(state.sr || '') !== sr || String(state.version || '') !== version) return null
  if (state.per !== undefined && Number(state.per) !== Number(per)) return null
  if (existsSync(join(settings.modelsDir, `${name}.pth`))) return null
  let hasCheckpoint = false
  try {
    hasCheckpoint = readdirSync(expDir).some((file) => file.startsWith('G_') && file.endsWith('.pth'))
  } catch {}
  const lastEpoch = Number(state.lastEpoch) || 0
  const slices = Number(state.slices) || 0
  // 至少要有检查点，或者已经切出片段（可以复用切分 / F0 / HuBERT 接着做）。
  if (!hasCheckpoint && lastEpoch <= 0 && slices <= 0) return null
  return {
    expDir,
    lastEpoch,
    totalEpochs: Number(state.epochs) || 0,
    hasCheckpoint,
    slices,
    stage: String(state.stage || ''),
    updatedAt: Number(state.updatedAt) || 0,
  }
}

function trainingState(settings, deps) {
  const items = deps?.items || []
  const missing = []
  for (const id of TRAIN_ITEMS) {
    const item = items.find((x) => x.id === id)
    if (!item || !item.ok) missing.push({ id, label: item?.label || id, detail: item?.detail || '' })
  }
  const pretrainedReady = existsSync(join(settings.rvcDir, 'assets', 'pretrained_v2', 'f0G48k.pth'))
    && existsSync(join(settings.rvcDir, 'assets', 'pretrained_v2', 'f0D48k.pth'))
  return { ok: missing.length === 0, missing, pretrainedReady }
}

export function apply(ctx, config = {}) {
  ensureDir(dataDir())
  ensureDir(dataDir('songs'))
  ensureDir(dataDir('analysis'))
  ensureDir(dataDir('plans'))
  ensureDir(dataDir('renders'))
  ensureDir(dataDir('training'))
  ensureDir(dataDir('profiles'))

  const settingsFile = dataDir('settings.json')
  const saved = readJson(settingsFile, {})
  const projectRoot = saved.projectRoot || config.projectRoot || ''
  let settings = { ...defaultSettings(projectRoot, saved.runtimeRoot), ...saved }
  if (saved.projectRoot && !saved.mode) settings.mode = 'existing'
  if (!saved.mode && !saved.projectRoot) settings.mode = 'managed'
  const saveSettings = (next) => {
    settings = { ...settings, ...next, _pluginRoot: PLUGIN_ROOT }
    writeJson(settingsFile, Object.fromEntries(Object.entries(settings).filter(([k]) => !k.startsWith('_'))))
    return settings
  }
  saveSettings({})

  const jobs = new Jobs()
  ctx.effect(() => () => jobs.dispose(), 'singing: jobs')

  let rvcWorker = null
  let soulxWorker = null
  // 正在预加载的 Worker；用于「暂停加载」和防止并发预加载。
  let warmupToken = null
  const renderLocks = new Map()
  const resetWorkers = async () => {
    const a = rvcWorker
    const b = soulxWorker
    rvcWorker = null
    soulxWorker = null
    await Promise.all([a?.stop?.(), b?.stop?.()])
  }
  const getRvcWorker = () => {
    if (!rvcWorker) {
      rvcWorker = new WorkerClient({
        name: 'RVC',
        python: settings.pythonPath,
        script: join(PLUGIN_ROOT, 'engine', 'rvc_worker.py'),
        args: ['--rvc-dir', settings.rvcDir],
        cwd: settings.rvcDir,
        onLog: (line) => console.log('[singing:rvc]', line),
      })
    }
    return rvcWorker
  }
  const getSoulxWorker = () => {
    if (!soulxWorker) {
      soulxWorker = new WorkerClient({
        name: 'SoulX',
        python: settings.soulxPython,
        script: join(PLUGIN_ROOT, 'engine', 'soulx_worker.py'),
        args: [
          '--soulx-dir', settings.soulxDir,
          '--model', settings.soulxModel,
          '--config', settings.soulxConfig,
          '--device', settings.soulxDevice === 'auto' ? '' : settings.soulxDevice,
        ],
        cwd: settings.soulxDir,
        onLog: (line) => console.log('[singing:soulx]', line),
      })
    }
    return soulxWorker
  }
  ctx.effect(() => () => { resetWorkers().catch(() => {}) }, 'singing: workers')

  const publicSettings = () => ({
    mode: settings.mode,
    runtimeRoot: settings.runtimeRoot,
    projectRoot: settings.projectRoot,
    systemPython: settings.systemPython,
    proxy: settings.proxy,
    uvPath: settings.uvPath,
    autoWarmup: settings.autoWarmup,
    pythonPath: settings.pythonPath,
    rvcDir: settings.rvcDir,
    modelsDir: settings.modelsDir,
    ffmpeg: settings.ffmpeg,
    ffprobe: settings.ffprobe,
    separatorExe: settings.separatorExe,
    separatorModelDir: settings.separatorModelDir,
    separatorModel: settings.separatorModel,
    separatorOverlap: settings.separatorOverlap,
    soulxPython: settings.soulxPython,
    soulxDir: settings.soulxDir,
    soulxModel: settings.soulxModel,
    soulxConfig: settings.soulxConfig,
    soulxDevice: settings.soulxDevice,
    soulxSteps: settings.soulxSteps,
    soulxCfg: settings.soulxCfg,
    soulxPromptSeconds: settings.soulxPromptSeconds,
    soulxPromptWav: settings.soulxPromptWav,
    targetCoverage: settings.targetCoverage,
    maxOctaves: settings.maxOctaves,
    maxCandidates: settings.maxCandidates,
    protect: settings.protect,
    rmsMixRate: settings.rmsMixRate,
    indexRate: settings.indexRate,
    crossfadeMs: settings.crossfadeMs,
    fillGap: settings.fillGap,
    phraseGap: settings.phraseGap,
    sectionGap: settings.sectionGap,
    minPhrase: settings.minPhrase,
    topDb: settings.topDb,
    maxUploadMB: settings.maxUploadMB,
    neteaseCookieSet: Boolean(settings.neteaseCookie),
    checks: {
      python: existsSync(settings.pythonPath),
      rvc: existsSync(settings.rvcDir),
      models: existsSync(settings.modelsDir),
      separator: Boolean(settings.separatorExe && existsSync(settings.separatorExe)),
      separatorModels: Boolean(settings.separatorModelDir && existsSync(settings.separatorModelDir)),
      soulxPython: Boolean(settings.soulxPython && existsSync(settings.soulxPython)),
      soulx: Boolean(settings.soulxPython && settings.soulxDir && settings.soulxModel && settings.soulxConfig
        && existsSync(settings.soulxPython) && existsSync(settings.soulxDir)
        && existsSync(settings.soulxModel) && existsSync(settings.soulxConfig)),
    },
  })

  const songs = () => {
    const out = []
    let ids = []
    try { ids = readdirSync(dataDir('songs')) } catch {}
    for (const id of ids) {
      if (!sameId(id)) continue
      const meta = readJson(dataDir('songs', id, 'meta.json'), null)
      if (meta) out.push(meta)
    }
    out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    return out
  }

  // 分析结果很大，只缓存界面需要的小字段；文件 mtime 变了再重读。
  const analysisMetaCache = new Map()
  const analysisMetaOf = (id) => {
    const file = dataDir('analysis', `${id}.json`)
    let st
    try { st = statSync(file) } catch { return null }
    const cached = analysisMetaCache.get(id)
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.value
    const analysis = readJson(file, null)
    if (!analysis) return null
    const value = {
      id,
      songId: analysis.songId || '',
      voiceId: analysis.voiceId || '',
      createdAt: Number(analysis.createdAt) || st.mtimeMs,
      duration: Number(analysis.duration) || 0,
      coverage: analysis.coverage || null,
      phrases: Array.isArray(analysis.phrases) ? analysis.phrases.length : 0,
      sections: Array.isArray(analysis.sections) ? analysis.sections.length : 0,
    }
    analysisMetaCache.set(id, { mtimeMs: st.mtimeMs, value })
    return value
  }
  const listAnalysisMeta = () => {
    let ids = []
    try { ids = readdirSync(dataDir('analysis')) } catch {}
    const out = []
    for (const name of ids) {
      if (!name.endsWith('.json') || name.endsWith('.meta.json')) continue
      const id = name.slice(0, -5)
      if (!sameId(id)) continue
      const meta = analysisMetaOf(id)
      if (meta) out.push(meta)
    }
    return out
  }
  const listRenderRows = () => {
    let dirs = []
    try { dirs = readdirSync(dataDir('renders')) } catch {}
    const out = []
    for (const id of dirs) {
      if (!sameId(id)) continue
      const dir = dataDir('renders', id)
      const meta = readJson(join(dir, 'meta.json'), null)
      const plan = readJson(join(dir, 'plan.json'), null)
      const analysisId = String(meta?.analysisId || plan?.analysisId || '')
      if (!sameId(analysisId)) continue
      const hasMix = existsSync(join(dir, 'mix.mp3'))
      const hasWav = existsSync(join(dir, 'mix.wav'))
      if (!hasMix && !hasWav) continue
      let createdAt = Number(meta?.createdAt) || 0
      if (!createdAt) { try { createdAt = statSync(join(dir, 'plan.json')).mtimeMs } catch {} }
      out.push({
        id,
        analysisId,
        audioUrl: hasMix ? `${PREFIX}/audio?kind=mix&id=${id}` : `${PREFIX}/audio?kind=wav&id=${id}`,
        wavUrl: `${PREFIX}/audio?kind=wav&id=${id}`,
        backend: meta?.backend || 'rvc',
        voiceId: meta?.voiceId || plan?.voiceId || '',
        level: meta?.level || plan?.level || '',
        coverage: meta?.coverage || null,
        changes: meta?.changes ?? null,
        duration: Number(meta?.duration) || 0,
        createdAt,
      })
    }
    out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    return out
  }

  /** 把一段音频写进歌曲库；fileName 只用来取扩展名，displayName 是界面上显示的名字。 */
  const importSongBuffer = async (buf, fileName, displayName, extra = {}) => {
    if (!buf?.length) throw new Error('空文件')
    const ext = extname(fileName).toLowerCase()
    if (!AUDIO_EXT.has(ext)) throw new Error(`不支持的音频格式：${ext || '(无)'}`)
    const id = sha1(Buffer.concat([buf, Buffer.from(fileName)]))
    const dir = dataDir('songs', id)
    const metaFile = join(dir, 'meta.json')
    if (existsSync(metaFile)) {
      const song = readJson(metaFile, null) || {}
      // 老歌曲补上网易云 id，之后搜索就能直接按 id 判断「已下载」。
      if (Object.keys(extra).length) {
        const merged = { ...song, ...extra }
        try { writeJson(metaFile, merged) } catch {}
        return { song: merged, cached: true }
      }
      return { song, cached: true }
    }
    ensureDir(dir)
    const src = join(dir, `upload${ext}`)
    const wav = join(dir, 'source.wav')
    writeFileSync(src, buf)
    await decodeToWav(settings, src, wav)
    const duration = await probeDuration(settings, wav)
    const meta = {
      ...extra,
      id,
      name: displayName || fileName,
      ext,
      size: buf.length,
      duration: Math.round(duration * 100) / 100,
      createdAt: Date.now(),
      stems: false,
    }
    writeJson(join(dir, 'meta.json'), meta)
    return { song: meta, cached: false }
  }

  const depsState = (refresh = false) => checkDependencies(settings, { refresh })
  const gate = () => {
    const d = depsState()
    if (d.ready) return null
    return {
      ok: false,
      code: 'env-not-ready',
      message: '环境还没有准备好，请先在「环境准备」里完成依赖检查/下载',
      missing: d.missing,
      deps: d,
    }
  }
  const state = () => {
    const voices = listVoices(settings, PLUGIN_ROOT)
    const deps = depsState()
    return {
      ok: true,
      version: '0.1.0',
      settings: publicSettings(),
      deps,
      workers: {
        rvc: rvcWorker ? { started: true, ...rvcWorker.status() } : { started: false },
        soulx: soulxWorker ? { started: true, ...soulxWorker.status() } : { started: false },
      },
      voices,
      songs: songs(),
      jobs: jobs.list(20),
      training: trainingState(settings, deps),
      dataDir: dataDir(),
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x')
    let path = url.pathname.slice(PREFIX.length) || '/'
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
    const method = req.method || 'GET'

    if (method === 'GET' && path === '/state') return sendJson(res, 200, state())
    if (method === 'POST' && path === '/models/inspect') {
      try {
        const body = await readJsonBody(req)
        return sendJson(res, 200, {
          ok: true,
          inspection: inspectModelPath(settings, PLUGIN_ROOT, body.path, { profilePath: body.profilePath }),
        })
      } catch (error) {
        return sendJson(res, 200, { ok: false, message: String(error?.message || error) })
      }
    }
    if (method === 'POST' && path === '/models/import') {
      try {
        const body = await readJsonBody(req)
        const result = importModel(settings, PLUGIN_ROOT, body.path, {
          profilePath: body.profilePath,
          overwrite: body.overwrite === true,
        })
        return sendJson(res, 200, result)
      } catch (error) {
        return sendJson(res, 200, { ok: false, message: String(error?.message || error) })
      }
    }
    if (method === 'POST' && path === '/soulx/voices') {
      try {
        const body = await readJsonBody(req)
        const result = await createSoulxVoice(settings, PLUGIN_ROOT, {
          promptWav: body.promptWav,
          label: body.label,
          name: body.name,
        })
        return sendJson(res, 200, result)
      } catch (error) {
        return sendJson(res, 200, { ok: false, message: String(error?.message || error) })
      }
    }
    if (method === 'POST' && path === '/models/profile') {
      try {
        const body = await readJsonBody(req)
        const result = await buildModelProfile(settings, PLUGIN_ROOT, {
          modelPath: body.modelPath,
          datasetPath: body.datasetPath,
          label: body.label,
        })
        return sendJson(res, 200, result)
      } catch (error) {
        return sendJson(res, 200, { ok: false, message: String(error?.message || error) })
      }
    }
    if (method === 'GET' && path === '/songs') return sendJson(res, 200, { ok: true, songs: songs() })
    if (method === 'GET' && path === '/jobs') return sendJson(res, 200, { ok: true, jobs: jobs.list(30) })
    if (method === 'GET' && path === '/deps') {
      const d = depsState(url.searchParams.get('refresh') === '1')
      return sendJson(res, 200, { ok: true, ...d })
    }
    if (method === 'GET' && path === '/env/manifest') {
      return sendJson(res, 200, { ok: true, entries: downloadManifest(settings), dataDir: dataDir() })
    }
    // 手动下载兜底：用户把已经下好的文件拖进页面，这里按清单 id 找到目标路径并写进去。
    // 目标只来自 downloadManifest，客户端不能指定任意路径。
    if (method === 'POST' && path === '/env/file') {
      const id = String(url.searchParams.get('id') || '')
      const name = String(url.searchParams.get('name') || '')
      const entry = downloadManifest(settings).find((e) => e.id === id)
      if (!entry) return sendJson(res, 404, { ok: false, message: '未知的下载项，刷新清单后再试' })
      const result = await placeUpload(req, entry, name)
      if (result.ok) invalidateDeps()
      return sendJson(res, result.status, result)
    }
    // 制作台歌曲库：歌曲 + 每个分析 + 已缓存翻唱成品，按歌曲聚合。
    if (method === 'GET' && path === '/library') {
      const analyses = listAnalysisMeta()
      const renders = listRenderRows()
      const byId = new Map(analyses.map((a) => [a.id, a]))
      const out = songs().map((song) => {
        const own = analyses
          .filter((a) => a.songId === song.id)
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        const ids = new Set(own.map((a) => a.id))
        const covers = renders
          .filter((r) => ids.has(r.analysisId) && byId.has(r.analysisId))
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        return {
          ...song,
          analyses: own,
          renders: covers,
          coverCount: covers.length,
          latestCover: covers[0] || null,
        }
      })
      return sendJson(res, 200, { ok: true, songs: out })
    }
    if (method === 'POST' && path === '/setup') {
      const job = jobs.create('setup', async (job) => {
        const report = (stage, p, msg) => jobs.progress(job, stage, p, msg)
        const patch = await setupAll(settings, PLUGIN_ROOT, { report, job })
        saveSettings(patch)
        invalidateDeps()
        await resetWorkers()
        const deps = depsState(true)
        return { patch, ready: deps.ready, missing: deps.missing, deps }
      }, {})
      return sendJson(res, 200, { ok: true, job: jobs.get(job.id) })
    }
    if (method === 'POST' && path === '/warmup') {
      const body = await readJsonBody(req)
      const which = String(body.backend || 'rvc')
      if (warmupToken) {
        return sendJson(res, 200, { ok: false, cancelled: false, message: '模型正在加载，先等它完成或点「暂停加载」' })
      }
      const w = which === 'soulx' ? getSoulxWorker() : getRvcWorker()
      const token = { backend: which, worker: w, cancelled: false }
      warmupToken = token
      try {
        await w.start()
        if (token.cancelled) throw new Error('已暂停加载')
        if (which !== 'soulx' && body.voiceId) {
          const voice = resolveVoice(settings, PLUGIN_ROOT, String(body.voiceId))
          if (voice.file) await w.request('load_voice', { model: voice.file })
        }
        if (token.cancelled) throw new Error('已暂停加载')
        return sendJson(res, 200, { ok: true, cancelled: false, backend: which, worker: w.status() })
      } catch (error) {
        if (token.cancelled) {
          return sendJson(res, 200, { ok: false, cancelled: true, backend: which, message: '已暂停加载' })
        }
        return sendJson(res, 200, { ok: false, cancelled: false, message: String(error.message || error) })
      } finally {
        if (warmupToken === token) warmupToken = null
      }
    }

    // 暂停预加载：直接杀掉还在启动的 Worker，不等模型加载完。
    if (method === 'POST' && path === '/warmup/cancel') {
      const body = await readJsonBody(req)
      const which = String(body.backend || '')
      const token = warmupToken
      if (!token) return sendJson(res, 200, { ok: true, cancelled: false, message: '没有正在加载的模型' })
      if (which && token.backend !== which) {
        return sendJson(res, 200, { ok: true, cancelled: false, backend: token.backend, message: '这个后端没有在加载' })
      }
      token.cancelled = true
      try { token.worker?.kill?.('已暂停加载') } catch {}
      return sendJson(res, 200, { ok: true, cancelled: true, backend: token.backend })
    }

    // 卸载常驻模型：停掉指定后端的 Worker 进程，另一个后端不受影响。
    if (method === 'POST' && path === '/warmup/unload') {
      const body = await readJsonBody(req)
      const which = String(body.backend || 'rvc')
      if (jobs.running) {
        return sendJson(res, 200, { ok: false, message: '有任务正在使用模型，等它结束再卸载' })
      }
      if (warmupToken && warmupToken.backend === which) {
        warmupToken.cancelled = true
        try { warmupToken.worker?.kill?.('已卸载') } catch {}
      }
      const w = which === 'soulx' ? soulxWorker : rvcWorker
      if (!w) return sendJson(res, 200, { ok: true, backend: which, started: false, message: '模型未加载' })
      try {
        await w.stop()
      } catch (error) {
        return sendJson(res, 200, { ok: false, backend: which, message: String(error?.message || error) })
      }
      if (which === 'soulx') soulxWorker = null
      else rvcWorker = null
      return sendJson(res, 200, { ok: true, backend: which, started: false })
    }

    // 训练数据目录检查：只统计音频文件和体积，不读内容。
    if (method === 'GET' && path === '/train/check') {
      const deps = depsState()
      const training = trainingState(settings, deps)
      const raw = String(url.searchParams.get('path') || '').trim()
      if (!raw) return sendJson(res, 200, { ok: false, message: '请输入训练数据目录', training })
      const resolved = resolveUserPath(settings, raw)
      if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
        return sendJson(res, 200, { ok: false, message: `目录不存在：${resolved}`, path: resolved, training })
      }
      const files = []
      walkAudioFiles(resolved, files)
      let bytes = 0
      for (const file of files) {
        try { bytes += statSync(file).size } catch {}
      }
      return sendJson(res, 200, {
        ok: true,
        path: resolved,
        files: files.length,
        bytes,
        samples: files.slice(0, 6).map((file) => file.split(/[\\/]/).pop()),
        training,
      })
    }

    if (method === 'POST' && path === '/train') {
      const body = await readJsonBody(req)
      const datasetRaw = String(body.datasetPath || '').trim()
      const dataset = resolveUserPath(settings, datasetRaw)
      const name = String(body.name || '').trim()
      const label = String(body.label || '').trim().slice(0, 40) || name
      const sr = String(body.sr || '48k')
      const version = String(body.version || 'v2')
      const f0Method = String(body.f0Method || 'rmvpe')
      const device = String(body.device || 'auto')
      const epochs = Math.max(1, Math.min(500, Number(body.epochs) || 20))
      const batchSize = Math.max(1, Math.min(32, Number(body.batchSize) || 4))
      const saveEvery = Math.max(1, Math.min(100, Number(body.saveEvery) || 5))
      const auditionEvery = Math.max(0, Math.min(100, Math.trunc(Number(body.auditionEvery) || 0)))
      const per = Math.max(1, Math.min(10, Number(body.per) || 3.7))
      const nP = Math.max(1, Math.min(8, Number(body.nP) || 2))
      const useIndex = body.index !== false
      const usePretrained = body.pretrained !== false

      const deps = depsState(true)
      const training = trainingState(settings, deps)
      if (!training.ok) {
        return sendJson(res, 200, {
          ok: false,
          code: 'train-not-ready',
          message: `训练环境还没准备好：${training.missing.map((x) => x.label).join('、') || '缺少依赖'}。请先去「环境」页一键准备。`,
          training,
        })
      }
      // managed 的推理 / 训练代码归插件托管：每次开始训练前同步一遍，避免 runtime 里
      // 还是旧版本（比如没有「停止保存检查点」的 train.py）。
      if (settings.mode === 'managed') {
        try { syncVendorCode(settings, PLUGIN_ROOT) } catch {}
      }
      if (!['32k', '40k', '48k'].includes(sr)) return sendJson(res, 400, { ok: false, message: '采样率只能是 32k / 40k / 48k' })
      if (!['v1', 'v2'].includes(version)) return sendJson(res, 400, { ok: false, message: '版本只能是 v1 / v2' })
      if (!['rmvpe', 'pm'].includes(f0Method)) return sendJson(res, 400, { ok: false, message: 'F0 方法只能是 rmvpe / pm' })
      if (!['auto', 'cpu', 'cuda'].includes(device)) return sendJson(res, 400, { ok: false, message: '设备只能是 auto / cpu / cuda' })
      if (!TRAIN_NAME_RE.test(name)) return sendJson(res, 400, { ok: false, message: '模型名只能包含字母、数字、下划线、短横线（40 字符以内）' })
      if (!dataset || !existsSync(dataset) || !statSync(dataset).isDirectory()) {
        return sendJson(res, 200, { ok: false, message: `训练数据目录不存在：${dataset || '(空)'}` })
      }
      const files = []
      walkAudioFiles(dataset, files)
      if (!files.length) return sendJson(res, 200, { ok: false, message: '训练数据目录里没有可用的音频文件（wav/flac/mp3/m4a/ogg）' })
      if (usePretrained && sr === '48k' && version === 'v2' && !training.pretrainedReady) {
        return sendJson(res, 200, {
          ok: false,
          code: 'train-no-pretrained',
          message: '缺少 48k 预训练底模（f0G48k / f0D48k）。请先去「环境」页准备，或取消「使用预训练底模」从零训练。',
        })
      }
      const expDir = join(settings.rvcDir, 'logs', name)
      const modelFile = join(settings.modelsDir, `${name}.pth`)
      const weightFile = join(settings.rvcDir, 'assets', 'weights', `${name}.pth`)
      const profileFile = join(dataDir('profiles'), `${name}.json`)
      const conflicts = []
      let expCount = 0
      try { expCount = existsSync(expDir) ? readdirSync(expDir).length : 0 } catch {}
      if (expCount > 0) conflicts.push(expDir)
      for (const file of [modelFile, weightFile, profileFile]) {
        if (existsSync(file)) conflicts.push(file)
      }

      const wantsResume = body.resume === true
      const resumeInfo = trainResumeInfo(settings, name, dataset, sr, version, per)
      if (wantsResume) {
        if (!resumeInfo) {
          return sendJson(res, 200, { ok: false, message: '没有找到可继续的训练，请重新开始' })
        }
        if (resumeInfo.lastEpoch > 0 && epochs < resumeInfo.lastEpoch) {
          return sendJson(res, 200, {
            ok: false,
            message: `上次已经训到第 ${resumeInfo.lastEpoch} 轮，总轮数不能小于它（当前填的是 ${epochs}）`,
          })
        }
      } else if (body.overwrite !== true && resumeInfo) {
        // 前端弹「上次训练未完成，是否继续」。
        return sendJson(res, 200, {
          ok: false,
          code: 'train-resumable',
          message: `上次训练未完成：${expDir}`,
          resumable: resumeInfo,
        })
      }

      if (!wantsResume && conflicts.length) {
        // 前端弹「已有同名，是否清除掉」，确认后带 overwrite 再提交一次。
        if (body.overwrite !== true) {
          return sendJson(res, 200, {
            ok: false,
            code: 'train-exists',
            message: `同名训练已存在：${conflicts[0]}`,
            conflicts,
          })
        }
        // 只删 managed 目录里的同名产物：训练目录、权重、模型、音域 Profile。
        const roots = [
          join(settings.rvcDir, 'logs'),
          join(settings.rvcDir, 'assets', 'weights'),
          settings.modelsDir,
          dataDir('profiles'),
        ]
        for (const target of conflicts) {
          if (!roots.some((root) => isInside(root, target))) {
            return sendJson(res, 400, { ok: false, message: `拒绝删除路径：${target}` })
          }
          rmSync(target, { recursive: true, force: true })
        }
        // 上一轮训练每 N 轮导出的可试听模型也一起清掉，避免旧轮次混进新结果。
        try {
          const weightsDir = join(settings.rvcDir, 'assets', 'weights')
          for (const file of readdirSync(weightsDir)) {
            if (file.startsWith(`${name}_e`) && file.endsWith('.pth')) {
              rmSync(join(weightsDir, file), { force: true })
            }
          }
        } catch {}
        try {
          const activeFile = dataDir('training', 'voice-epochs.json')
          const active = readJson(activeFile, {}) || {}
          if (active[name]) {
            delete active[name]
            writeJson(activeFile, active)
          }
        } catch {}
      }

      const job = jobs.create('train', async (job) => {
        const resultFile = dataDir('training', `${job.id}.json`)
        const logFile = dataDir('training', `${job.id}.log`)
        const args = [
          join(PLUGIN_ROOT, 'engine', 'train.py'),
          '--rvc-dir', settings.rvcDir,
          '--dataset', dataset,
          '--name', name,
          '--label', label,
          '--sr', sr,
          '--version', version,
          '--epochs', String(epochs),
          '--batch-size', String(batchSize),
          '--save-every', String(saveEvery),
          '--audition-every', String(auditionEvery),
          '--per', String(per),
          '--f0-method', f0Method,
          '--n-p', String(nP),
          '--index', useIndex ? '1' : '0',
          '--pretrained', usePretrained ? '1' : '0',
          '--device', device,
          '--resume', wantsResume ? '1' : '0',
          '--models-dir', settings.modelsDir,
          '--profiles-dir', dataDir('profiles'),
          '--result', resultFile,
          '--log', logFile,
        ]
        await run(settings.pythonPath, args, {
          cwd: PLUGIN_ROOT,
          job,
          onLine: (line) => {
            if (!line.startsWith('PROGRESS ')) return
            let payload
            try { payload = JSON.parse(line.slice(9)) } catch { return }
            jobs.progress(
              job,
              String(payload.stage || '训练'),
              Number(payload.progress) || 0,
              String(payload.message || ''),
              payload.detail || null,
            )
          },
        })
        const result = readJson(resultFile, null)
        if (!result) throw new Error('训练进程结束但没有写出结果文件')
        return result
      }, { datasetPath: dataset, name, label, sr, version, epochs, auditionEvery, resume: wantsResume })
      return sendJson(res, 200, { ok: true, job: jobs.get(job.id) })
    }

    if (method === 'POST' && path === '/train/use') {
      const body = await readJsonBody(req)
      const name = String(body.name || '').trim()
      const epoch = Math.trunc(Number(body.epoch) || 0)
      if (!TRAIN_NAME_RE.test(name)) return sendJson(res, 400, { ok: false, message: '模型名不合法' })
      if (epoch < 0) return sendJson(res, 400, { ok: false, message: '轮次不合法' })
      const weightsDir = join(settings.rvcDir, 'assets', 'weights')
      let picked = ''
      if (epoch === 0) {
        // 0 = 最终模型
        const finalFile = join(weightsDir, `${name}.pth`)
        if (existsSync(finalFile)) picked = finalFile
      } else {
        try {
          const prefix = `${name}_e${epoch}_s`
          const matches = readdirSync(weightsDir)
            .filter((file) => file.startsWith(prefix) && file.endsWith('.pth'))
            .sort((a, b) => Number(a.slice(prefix.length, -4)) - Number(b.slice(prefix.length, -4)))
          if (matches.length) picked = join(weightsDir, matches[matches.length - 1])
        } catch {}
      }
      if (!picked || !existsSync(picked)) {
        return sendJson(res, 200, { ok: false, message: epoch === 0 ? '没有找到最终模型' : `没有找到第 ${epoch} 轮的可试听模型` })
      }
      ensureDir(settings.modelsDir)
      const modelPath = join(settings.modelsDir, `${name}.pth`)
      try {
        copyFileSync(picked, modelPath)
      } catch (error) {
        return sendJson(res, 200, { ok: false, message: `复制失败：${String(error && error.message ? error.message : error)}` })
      }
      try {
        const activeFile = dataDir('training', 'voice-epochs.json')
        const active = readJson(activeFile, {}) || {}
        active[name] = { epoch, at: Date.now() }
        writeJson(activeFile, active)
      } catch {}
      const profilePath = join(dataDir('profiles'), `${name}.json`)
      const hasProfile = existsSync(profilePath)
      return sendJson(res, 200, {
        ok: true,
        voiceId: name,
        epoch,
        modelPath,
        profilePath: hasProfile ? profilePath : '',
        hasProfile,
      })
    }

    if (method === 'GET' && path === '/train/models') {
      return sendJson(res, 200, { ok: true, ...listAuditionModels(settings) })
    }

    if (method === 'GET' && path.startsWith('/jobs/')) {
      const id = path.slice('/jobs/'.length)
      if (!sameId(id)) return sendJson(res, 400, { ok: false, message: '非法任务 ID' })
      const job = jobs.get(id)
      if (!job) return sendJson(res, 404, { ok: false, message: '任务不存在' })
      return sendJson(res, 200, { ok: true, job })
    }

    if (method === 'POST' && path.startsWith('/cancel/')) {
      const id = path.slice('/cancel/'.length)
      if (!sameId(id)) return sendJson(res, 400, { ok: false, message: '非法任务 ID' })
      const before = jobs.get(id)
      const ok = jobs.cancel(id)
      // 分析和渲染在常驻 Worker 里跑；取消时把 Worker 一起停掉，请求才会真正中断。
      if (ok && before && (before.type === 'render' || before.type === 'analyze') && before.status === 'running') {
        resetWorkers().catch(() => {})
      }
      return sendJson(res, 200, { ok })
    }

    if (method === 'POST' && path === '/settings') {
      const body = await readJsonBody(req)
      const keys = Object.keys(defaultSettings()).filter((k) => k in body)
      const next = {}
      for (const k of keys) {
        const v = body[k]
        if (typeof v === 'number' && Number.isFinite(v)) next[k] = v
        else if (typeof v === 'string') next[k] = v.trim()
        else if (typeof v === 'boolean') next[k] = v
      }
      if (typeof next.projectRoot === 'string') {
        const d = defaultSettings(next.projectRoot, next.runtimeRoot || settings.runtimeRoot)
        for (const k of ['pythonPath', 'rvcDir', 'modelsDir', 'soulxPython', 'soulxDir', 'soulxModel', 'soulxConfig', 'separatorExe', 'separatorModelDir']) {
          if (!(k in next)) next[k] = d[k]
        }
        if (!('mode' in next)) next.mode = next.projectRoot ? 'existing' : 'managed'
      }
      const before = JSON.stringify([settings.pythonPath, settings.rvcDir, settings.modelsDir, settings.soulxPython, settings.soulxDir, settings.soulxModel, settings.soulxConfig, settings.soulxDevice])
      saveSettings(next)
      invalidateDeps()
      const after = JSON.stringify([settings.pythonPath, settings.rvcDir, settings.modelsDir, settings.soulxPython, settings.soulxDir, settings.soulxModel, settings.soulxConfig, settings.soulxDevice])
      if (before !== after) resetWorkers().catch(() => {})
      return sendJson(res, 200, { ok: true, settings: publicSettings(), deps: depsState(true) })
    }

    if (method === 'POST' && path === '/songs') {
      const name = String(url.searchParams.get('name') || 'song')
      const ext = extname(name).toLowerCase()
      if (!AUDIO_EXT.has(ext)) return sendJson(res, 400, { ok: false, message: `不支持的音频格式：${ext || '(无)'}` })
      const buf = await readBody(req, Number(settings.maxUploadMB || 200) * 1024 * 1024)
      if (!buf.length) return sendJson(res, 400, { ok: false, message: '空文件' })
      try {
        const result = await importSongBuffer(buf, name)
        return sendJson(res, 200, { ok: true, ...result })
      } catch (error) {
        return sendJson(res, 200, { ok: false, message: String(error.message || error) })
      }
    }

    if (method === 'GET' && path === '/netease/search') {
      const query = String(url.searchParams.get('q') || '').trim().slice(0, 100)
      if (!query) return sendJson(res, 400, { ok: false, message: '请输入歌名或歌手' })
      const limit = Math.max(1, Math.min(10, Number(url.searchParams.get('limit')) || 8))
      try {
        const results = await searchSongs(query, { cookie: settings.neteaseCookie, limit })
        return sendJson(res, 200, { ok: true, results })
      } catch (error) {
        return sendJson(res, 200, { ok: false, message: `网易云搜索失败：${String(error.message || error)}` })
      }
    }

    if (method === 'POST' && path === '/netease/import') {
      const body = await readJsonBody(req)
      const id = String(body.id || '')
      if (!/^\d{1,20}$/.test(id)) return sendJson(res, 400, { ok: false, message: '非法歌曲 ID' })
      const rawName = String(body.name || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 120)
      const artists = String(body.artists || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 120)
      const label = [rawName || `网易云 ${id}`, artists].filter(Boolean).join(' - ')
      try {
        const found = await songUrl(id, { cookie: settings.neteaseCookie })
        if (!found.url) {
          throw new Error(`这首歌下不了：可能需要会员或版权限制${settings.neteaseCookie ? '' : '，可以在设置里填网易云 Cookie'}`)
        }
        if (found.trial) throw new Error('只拿到试听片段：会员歌需要在设置里填网易云 Cookie')
        const response = await fetch(found.url, {
          headers: { 'user-agent': USER_AGENT, referer: 'https://music.163.com/' },
          signal: AbortSignal.timeout(120000),
        })
        if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)
        const maxBytes = Number(settings.maxUploadMB || 200) * 1024 * 1024
        const declared = Number(response.headers.get('content-length') || 0)
        if (declared > maxBytes) throw new Error(`文件太大了（最多 ${Math.round(maxBytes / 1024 / 1024)}MB）`)
        const buf = Buffer.from(await response.arrayBuffer())
        if (buf.length > maxBytes) throw new Error(`文件太大了（最多 ${Math.round(maxBytes / 1024 / 1024)}MB）`)
        const ext = AUDIO_EXT.has(`.${found.type}`) ? `.${found.type}` : '.mp3'
        const result = await importSongBuffer(buf, `${label}${ext}`, label, {
          neteaseId: id,
          neteaseName: rawName,
          neteaseArtists: artists,
        })
        return sendJson(res, 200, { ok: true, ...result })
      } catch (error) {
        return sendJson(res, 200, { ok: false, message: String(error.message || error) })
      }
    }

    if (method === 'POST' && path === '/analyze') {
      const blocked = gate()
      if (blocked) return sendJson(res, 200, blocked)
      const body = await readJsonBody(req)
      const songId = String(body.songId || '')
      const voiceId = String(body.voiceId || '')
      if (!sameId(songId)) return sendJson(res, 400, { ok: false, message: '非法歌曲 ID' })
      const songDir = dataDir('songs', songId)
      const songMeta = readJson(join(songDir, 'meta.json'), null)
      if (!songMeta) return sendJson(res, 404, { ok: false, message: '歌曲不存在' })
      const voice = resolveVoice(settings, PLUGIN_ROOT, voiceId)

      const key = sha1([songId, voice.id, settings.phraseGap, settings.sectionGap, settings.minPhrase, settings.topDb].join('|'))
      const analysisPath = dataDir('analysis', `${key}.json`)
      if (existsSync(analysisPath)) {
        return sendJson(res, 200, { ok: true, analysisId: key, cached: true })
      }

      const job = jobs.create('analyze', async (job) => {
        const report = (stage, p, msg) => jobs.progress(job, stage, p, msg)
        let vocals = join(songDir, 'vocals.wav')
        let instrumental = join(songDir, 'instrumental.wav')
        if (!existsSync(vocals) || !existsSync(instrumental)) {
          const stems = await separate(settings, join(songDir, 'source.wav'), songDir, { job, report })
          vocals = stems.vocals
          instrumental = stems.instrumental
          writeJson(join(songDir, 'meta.json'), { ...songMeta, stems: true })
        } else {
          report('分离人声', 0.55, '已有分轨')
        }
        const worker = getRvcWorker()
        await worker.request('analyze', {
          audio: vocals,
          profile: voice.profile,
          out: analysisPath,
          params: {
            phraseGap: settings.phraseGap,
            sectionGap: settings.sectionGap,
            minPhrase: settings.minPhrase,
            topDb: settings.topDb,
          },
        }, {
          onProgress: (stage, value) => report('分析 F0', 0.55 + 0.45 * value, stage),
        })
        const analysis = readJson(analysisPath)
        if (!analysis) throw new Error('分析结果为空')
        analysis.songId = songId
        analysis.voiceId = voice.id
        analysis.analysisId = key
        analysis.createdAt = Date.now()
        writeJson(analysisPath, analysis)
        return {
          analysisId: key,
          duration: analysis.duration,
          phrases: analysis.phrases?.length || 0,
          sections: analysis.sections?.length || 0,
          coverage: analysis.coverage,
          profile: voice.profile,
        }
      }, { songId, voiceId: voice.id })
      return sendJson(res, 200, { ok: true, job: jobs.get(job.id) })
    }

    // 列出某个分析已经生成（缓存）过的成品，供前端在「翻唱」里切换试听。
    if (method === 'GET' && path === '/renders') {
      const analysisId = String(url.searchParams.get('analysisId') || '')
      if (!sameId(analysisId)) return sendJson(res, 400, { ok: false, message: '非法分析 ID' })
      const analysis = readJson(dataDir('analysis', `${analysisId}.json`), null)
      if (!analysis) return sendJson(res, 404, { ok: false, message: '分析不存在' })
      const history = readJson(dataDir('history.json'), [])
      const list = []
      let dirs = []
      try { dirs = readdirSync(dataDir('renders')) } catch {}
      for (const id of dirs) {
        if (!sameId(id)) continue
        const dir = dataDir('renders', id)
        const meta = readJson(join(dir, 'meta.json'), null)
        const planFile = readJson(join(dir, 'plan.json'), null)
        const owner = (meta && meta.analysisId) || (planFile && planFile.analysisId) || ''
        if (owner !== analysisId) continue
        const hasMix = existsSync(join(dir, 'mix.mp3'))
        const hasWav = existsSync(join(dir, 'mix.wav'))
        if (!hasMix && !hasWav) continue
        const row = Array.isArray(history) ? history.find((j) => j.id === id && j.type === 'render') : null
        let createdAt = Number(meta && meta.createdAt) || 0
        if (!createdAt) { try { createdAt = statSync(join(dir, 'plan.json')).mtimeMs } catch {} }
        list.push({
          id,
          audioUrl: `${PREFIX}/audio?kind=mix&id=${id}`,
          wavUrl: `${PREFIX}/audio?kind=wav&id=${id}`,
          backend: (meta && meta.backend) || (row && row.meta && row.meta.backend) || (row && row.result && row.result.backend) || 'rvc',
          voiceId: (meta && meta.voiceId) || (planFile && planFile.voiceId) || '',
          level: (meta && meta.level) || (planFile && planFile.level) || '',
          changes: meta && meta.changes != null ? meta.changes : null,
          coverage: (meta && meta.coverage) || null,
          duration: (meta && meta.duration) || analysis.duration,
          createdAt,
          shifts: (meta && meta.shifts) || (planFile && planFile.shifts) || [],
        })
      }
      list.sort((a, b) => b.createdAt - a.createdAt)
      return sendJson(res, 200, { ok: true, analysisId, songId: analysis.songId, renders: list })
    }

    if (method === 'GET' && path.startsWith('/analysis/')) {
      const id = path.slice('/analysis/'.length)
      if (!sameId(id)) return sendJson(res, 400, { ok: false, message: '非法分析 ID' })
      const analysis = readJson(dataDir('analysis', `${id}.json`), null)
      if (!analysis) return sendJson(res, 404, { ok: false, message: '分析不存在' })
      return sendJson(res, 200, { ok: true, analysis })
    }

    if (method === 'POST' && path === '/plan') {
      const blocked = gate()
      if (blocked) return sendJson(res, 200, blocked)
      const body = await readJsonBody(req)
      const analysisId = String(body.analysisId || '')
      if (!sameId(analysisId)) return sendJson(res, 400, { ok: false, message: '非法分析 ID' })
      const analysis = readJson(dataDir('analysis', `${analysisId}.json`), null)
      if (!analysis) return sendJson(res, 404, { ok: false, message: '分析不存在' })
      const options = body.options && typeof body.options === 'object' ? body.options : {}
      let profile = analysis.profile || {}
      let planVoice = analysis.voiceId || ''
      if (body.voiceId) {
        const v = resolveVoice(settings, PLUGIN_ROOT, String(body.voiceId))
        profile = v.profile
        planVoice = v.id
      }
      const result = buildPlans(analysis, profile, {
        targetCoverage: settings.targetCoverage,
        maxOctaves: settings.maxOctaves,
        maxCandidates: settings.maxCandidates,
        ...options,
      })
      const planId = sha1([analysisId, JSON.stringify(options), JSON.stringify(result.candidates)].join('|'))
      writeJson(dataDir('plans', `${planId}.json`), {
        id: planId, analysisId, voiceId: planVoice, createdAt: Date.now(), options, result,
      })
      return sendJson(res, 200, { ok: true, planId, ...result })
    }

    if (method === 'POST' && path === '/render') {
      const blocked = gate()
      if (blocked) return sendJson(res, 200, blocked)
      const body = await readJsonBody(req)
      const analysisId = String(body.analysisId || '')
      if (!sameId(analysisId)) return sendJson(res, 400, { ok: false, message: '非法分析 ID' })
      const analysis = readJson(dataDir('analysis', `${analysisId}.json`), null)
      if (!analysis) return sendJson(res, 404, { ok: false, message: '分析不存在' })
      const backend = String(body.backend || 'rvc')
      if (!['rvc', 'soulx'].includes(backend)) return sendJson(res, 400, { ok: false, message: `未知后端：${backend}` })
      const voice = resolveVoice(settings, PLUGIN_ROOT, String(body.voiceId || analysis.voiceId || ''), { backend })
      const songDir = dataDir('songs', analysis.songId)
      const vocals = join(songDir, 'vocals.wav')
      const instrumental = join(songDir, 'instrumental.wav')
      if (!existsSync(vocals)) return sendJson(res, 404, { ok: false, message: '人声分轨不存在' })
      const plan = body.plan && Array.isArray(body.plan.shifts) ? body.plan : null
      if (!plan) return sendJson(res, 400, { ok: false, message: '缺少 plan.shifts' })

      // 成品缓存：同一个分析 + 音色 + 后端 + 八度方案 + 渲染参数，只生成一次。
      const cacheKey = sha1([
        'render-v1', analysisId, voice.id, voice.file || '', backend,
        JSON.stringify(plan.shifts), plan.level || '',
        settings.protect, settings.rmsMixRate, settings.indexRate,
        settings.crossfadeMs, settings.fillGap,
        backend === 'soulx' ? [settings.soulxSteps, settings.soulxCfg, settings.soulxPromptSeconds].join(',') : '',
        backend === 'soulx' ? (voice.profile?.promptWav || settings.soulxPromptWav || '') : '',
      ].join('|'))
      const cacheDir = dataDir('renders', cacheKey)
      const cacheMeta = readJson(join(cacheDir, 'meta.json'), null)
      if (cacheMeta && existsSync(join(cacheDir, 'mix.mp3')) && existsSync(join(cacheDir, 'mix.wav'))) {
        return sendJson(res, 200, {
          ok: true,
          cached: true,
          backend: cacheMeta.backend || backend,
          level: cacheMeta.level || plan.level || '',
          coverage: cacheMeta.coverage || plan.coverage || null,
          changes: cacheMeta.changes ?? plan.changes ?? null,
          duration: cacheMeta.duration || analysis.duration,
          audioUrl: `${PREFIX}/audio?kind=mix&id=${cacheKey}`,
          wavUrl: `${PREFIX}/audio?kind=wav&id=${cacheKey}`,
          sourceUrl: `${PREFIX}/audio?kind=vocals&id=${analysis.songId}`,
        })
      }
      // 兼容升级前已经生成过的成品：老目录没有 meta.json，但 plan.json + mix 文件可以复用。
      const history = readJson(dataDir('history.json'), [])
      let legacyId = ''
      let legacyPlan = null
      let older = []
      try { older = readdirSync(dataDir('renders')) } catch {}
      for (const id of older) {
        if (!sameId(id)) continue
        const dir = dataDir('renders', id)
        const oldPlan = readJson(join(dir, 'plan.json'), null)
        if (!oldPlan) continue
        if (oldPlan.analysisId !== analysisId || oldPlan.voiceId !== voice.id) continue
        if (JSON.stringify(oldPlan.shifts) !== JSON.stringify(plan.shifts)) continue
        if ((oldPlan.level || '') !== (plan.level || '')) continue
        if (!existsSync(join(dir, 'mix.mp3')) || !existsSync(join(dir, 'mix.wav'))) continue
        const row = Array.isArray(history) ? history.find((j) => j.id === id && j.type === 'render') : null
        const oldBackend = row?.meta?.backend || row?.result?.backend || ''
        if (oldBackend && oldBackend !== backend) continue
        if (!oldBackend && backend !== 'rvc') continue
        legacyId = id
        legacyPlan = oldPlan
        break
      }
      if (legacyId) {
        return sendJson(res, 200, {
          ok: true,
          cached: true,
          legacy: true,
          backend,
          level: legacyPlan.level || plan.level || '',
          coverage: plan.coverage || null,
          changes: plan.changes ?? null,
          duration: analysis.duration,
          audioUrl: `${PREFIX}/audio?kind=mix&id=${legacyId}`,
          wavUrl: `${PREFIX}/audio?kind=wav&id=${legacyId}`,
          sourceUrl: `${PREFIX}/audio?kind=vocals&id=${analysis.songId}`,
        })
      }
      const running = renderLocks.get(cacheKey)
      if (running) {
        const previous = jobs.get(running)
        if (previous && (previous.status === 'queued' || previous.status === 'running')) {
          return sendJson(res, 200, { ok: true, reused: true, job: previous })
        }
        renderLocks.delete(cacheKey)
      }

      let prompt = ''
      if (backend === 'soulx') {
        if (!settings.soulxPython || !existsSync(settings.soulxPython)) return sendJson(res, 200, { ok: false, message: 'SoulX Python 未配置：请先创建 .venv-soulx 或在设置里填路径' })
        if (!settings.soulxModel || !existsSync(settings.soulxModel)) return sendJson(res, 200, { ok: false, message: 'SoulX 模型未下载：请把 model-svc.pt 放到设置里的路径' })
        if (!settings.soulxDir || !existsSync(settings.soulxDir)) return sendJson(res, 200, { ok: false, message: 'SoulX 代码目录不存在' })
        try { prompt = soulxPromptPath(settings, voice) } catch (error) {
          return sendJson(res, 200, { ok: false, message: String(error.message || error) })
        }
      }

      const job = jobs.create('render', async (job) => {
        const report = (stage, p, msg) => jobs.progress(job, stage, p, msg)
        const dir = ensureDir(cacheDir)
        const planPath = join(dir, 'plan.json')
        writeJson(planPath, { shifts: plan.shifts, analysisId, voiceId: voice.id, level: plan.level || '' })
        const rvcOut = join(dir, 'vocals_converted.wav')
        if (backend === 'soulx') {
          const worker = getSoulxWorker()
          await worker.request('render', {
            input: vocals,
            analysis: dataDir('analysis', `${analysisId}.json`),
            plan: planPath,
            prompt,
            out: rvcOut,
            params: {
              steps: settings.soulxSteps,
              cfg: settings.soulxCfg,
              promptSeconds: settings.soulxPromptSeconds,
            },
          }, {
            onProgress: (stage, value) => report('SoulX-SVC', 0.02 + 0.78 * value, stage),
          })
        } else {
          const worker = getRvcWorker()
          await worker.request('render', {
            input: vocals,
            model: voice.file,
            plan: planPath,
            out: rvcOut,
            params: {
              protect: settings.protect,
              rmsMixRate: settings.rmsMixRate,
              indexRate: settings.indexRate,
              crossfadeMs: settings.crossfadeMs,
              fillGap: settings.fillGap,
            },
          }, {
            onProgress: (stage, value) => report('渲染人声', 0.02 + 0.78 * value, stage),
          })
        }
        const mixWav = join(dir, 'mix.wav')
        const mixMp3 = join(dir, 'mix.mp3')
        await mix(settings, { vocals: rvcOut, instrumental, outWav: mixWav, outMp3: mixMp3 }, { job, report })
        writeJson(join(dir, 'meta.json'), {
          version: 1,
          analysisId,
          voiceId: voice.id,
          backend,
          level: plan.level || '',
          coverage: plan.coverage || null,
          changes: plan.changes ?? null,
          duration: analysis.duration,
          createdAt: Date.now(),
          shifts: plan.shifts,
        })
        return {
          backend,
          level: plan.level || '',
          coverage: plan.coverage || null,
          changes: plan.changes ?? null,
          audioUrl: `${PREFIX}/audio?kind=mix&id=${cacheKey}`,
          wavUrl: `${PREFIX}/audio?kind=wav&id=${cacheKey}`,
          sourceUrl: `${PREFIX}/audio?kind=vocals&id=${analysis.songId}`,
          duration: analysis.duration,
        }
      }, { analysisId, voiceId: voice.id, backend, songId: analysis.songId, songName: readJson(dataDir('songs', analysis.songId, 'meta.json'), null)?.name || analysis.songId, planLabel: plan.level || '' })
      renderLocks.set(cacheKey, job.id)
      return sendJson(res, 200, { ok: true, job: jobs.get(job.id) })
    }

    // 前端诊断（只在音频异常时调用）：把播放器看到的媒体状态写到 client.log，便于定位“翻唱不能跳转”这类问题。
    if (method === 'POST' && path === '/client-log') {
      const body = await readJsonBody(req, 64 * 1024)
      const file = dataDir('client.log')
      try {
        let size = 0
        try { size = statSync(file).size } catch {}
        if (size < 512 * 1024) {
          ensureDir(dataDir())
          appendFileSync(file, `${JSON.stringify({ at: Date.now(), ...body })}\n`, 'utf8')
        }
      } catch {}
      return sendJson(res, 200, { ok: true })
    }

    if ((method === 'GET' || method === 'HEAD') && path === '/audio') {
      const kind = String(url.searchParams.get('kind') || 'mix')
      const id = String(url.searchParams.get('id') || '')
      if (!sameId(id)) return sendJson(res, 400, { ok: false, message: '非法音频 ID' })
      let file = ''
      if (kind === 'mix' || kind === 'wav') {
        const dir = dataDir('renders', id)
        file = kind === 'wav' ? join(dir, 'mix.wav') : join(dir, 'mix.mp3')
      } else if (kind === 'source' || kind === 'vocals' || kind === 'instrumental') {
        const dir = dataDir('songs', id)
        file = join(dir, kind === 'source' ? 'source.wav' : `${kind}.wav`)
      }
      if (!file || !existsSync(file)) return sendJson(res, 404, { ok: false, message: '音频不存在' })
      return streamFile(req, res, file)
    }

    return sendJson(res, 404, { ok: false, message: `未知接口：${method} ${path}` })
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: (req, res) => {
      handle(req, res).catch((error) => {
        try {
          sendJson(res, 200, { ok: false, message: String(error && error.message ? error.message : error) })
        } catch {}
      })
    },
  }), 'singing: api')
}

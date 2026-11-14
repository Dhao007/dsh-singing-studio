import {
  closeSync, copyFileSync, existsSync, openSync, readdirSync, readSync, statSync,
} from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { dataDir, ensureDir, readJson, writeJson } from './store.js'

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/
const PROFILE_KEYS = ['p1', 'p5', 'p95', 'p99']
const MODEL_EXTS = new Set(['.pth'])
const AUDIO_HINT = 'RVC 模型应是 PyTorch 保存的 .pth 检查点'

function unique(list) {
  return [...new Set(list.filter(Boolean))]
}

export function baseIdOf(file) {
  return basename(String(file || ''), extname(String(file || ''))).replace(/_e\d+_s\d+$/i, '')
}

function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/** 路径校验：绝对路径直接使用；相对路径优先按插件目录解析。 */
export function resolveModelInput(settings, pluginRoot, raw) {
  const value = expandHome(String(raw || '').trim())
  if (!value) return ''
  if (isAbsolute(value)) return resolve(value)
  const bases = [settings?.projectRoot, pluginRoot, process.cwd()].filter(Boolean)
  for (const base of bases) {
    const candidate = resolve(base, value)
    if (existsSync(candidate)) return candidate
  }
  return resolve(bases[0] || process.cwd(), value)
}

function fileSize(file) {
  try { return statSync(file).size } catch { return 0 }
}

function readHead(file, bytes = 8) {
  let fd
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(bytes)
    const n = readSync(fd, buf, 0, bytes, 0)
    return buf.subarray(0, n)
  } catch {
    return Buffer.alloc(0)
  } finally {
    if (fd != null) { try { closeSync(fd) } catch {} }
  }
}

/** 读取 zip 中央目录里的文件名；只做结构检查，不执行 pickle。 */
function readZipEntries(file) {
  const size = fileSize(file)
  if (size < 22) return []
  const tailLen = Math.min(size, 65557 + 22)
  let fd
  try {
    fd = openSync(file, 'r')
    const tail = Buffer.alloc(tailLen)
    readSync(fd, tail, 0, tailLen, size - tailLen)
    let eocd = -1
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
    }
    if (eocd < 0) return []
    const count = tail.readUInt16LE(eocd + 10)
    const cdSize = tail.readUInt32LE(eocd + 12)
    const cdOffset = tail.readUInt32LE(eocd + 16)
    if (!count || !cdSize || cdOffset + cdSize > size) return []
    const cd = Buffer.alloc(cdSize)
    readSync(fd, cd, 0, cdSize, cdOffset)
    const names = []
    let p = 0
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break
      const nameLen = cd.readUInt16LE(p + 28)
      const extraLen = cd.readUInt16LE(p + 30)
      const commentLen = cd.readUInt16LE(p + 32)
      names.push(cd.toString('utf8', p + 46, p + 46 + nameLen))
      p += 46 + nameLen + extraLen + commentLen
    }
    return names
  } catch {
    return []
  } finally {
    if (fd != null) { try { closeSync(fd) } catch {} }
  }
}

/** 文件级格式检查：.pth 扩展名、大小、PyTorch zip 结构与 data.pkl。 */
export function inspectModelFile(file) {
  const path = resolve(String(file || ''))
  const name = basename(path)
  const ext = extname(name).toLowerCase()
  const result = { ok: false, path, fileName: name, bytes: 0, kind: '', entries: 0, message: '', issues: [], warnings: [] }
  if (!existsSync(path)) {
    result.issues.push('模型文件不存在')
    return result
  }
  if (!MODEL_EXTS.has(ext)) {
    result.issues.push(`扩展名应为 .pth，当前为 ${ext || '(无)'}`)
    return result
  }
  result.bytes = fileSize(path)
  const head = readHead(path, 4)
  if (head.length >= 2 && head[0] === 0x50 && head[1] === 0x4b) {
    result.kind = 'zip'
    const entries = readZipEntries(path)
    result.entries = entries.length
    const hasPickle = entries.some((x) => /(^|\/)data\.pkl$/.test(x))
    const hasTensor = entries.some((x) => /(^|\/)data\/\d+$/.test(x))
    if (!hasPickle) {
      result.issues.push('不是标准 PyTorch 检查点：zip 内缺少 data.pkl')
    } else if (!hasTensor) {
      result.issues.push('不是标准 PyTorch 检查点：zip 内没有权重张量')
    } else {
      result.ok = true
      result.message = `PyTorch zip 检查点 · ${entries.length} 个条目`
    }
  } else if (head.length >= 1 && head[0] === 0x80) {
    result.kind = 'pickle'
    result.ok = true
    result.warnings.push('旧版 pickle 格式；建议使用 RVC v2 的 zip 检查点')
    result.message = '旧版 pickle 检查点'
  } else {
    result.issues.push(AUDIO_HINT)
  }
  if (result.ok && result.bytes < 1024 * 1024) {
    result.ok = false
    result.issues.push('文件太小，不像完整的 RVC 模型')
  }
  return result
}

function looksLikeProfile(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && PROFILE_KEYS.some((key) => key in value)
}

function readProfileFile(file) {
  const data = readJson(file, null)
  return looksLikeProfile(data) ? data : null
}

function profileDirs(settings, pluginRoot) {
  return [
    join(pluginRoot || '', 'profiles'),
    dataDir('profiles'),
  ].filter(Boolean)
}

/** 先找模型同目录的 profile，再找插件数据目录 / 内置目录里的同名 profile。 */
export function findProfileFor(settings, pluginRoot, modelFile, modelId) {
  const dir = dirname(modelFile)
  const siblings = []
  try {
    const names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.json'))
    const preferred = [
      `${modelId}.json`,
      `${basename(modelFile, extname(modelFile))}.json`,
      'profile.json',
    ]
    for (const name of preferred) {
      if (names.includes(name)) siblings.push(join(dir, name))
    }
    for (const name of names) {
      const full = join(dir, name)
      if (!siblings.includes(full)) siblings.push(full)
    }
  } catch {}
  for (const file of siblings) {
    const data = readProfileFile(file)
    if (data) return { path: file, data }
  }
  for (const dir of profileDirs(settings, pluginRoot)) {
    const exact = join(dir, `${modelId}.json`)
    const data = readProfileFile(exact)
    if (data) return { path: exact, data }
    try {
      for (const name of readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.json'))) {
        const full = join(dir, name)
        const candidate = readProfileFile(full)
        if (candidate && String(candidate.id || '') === String(modelId)) return { path: full, data: candidate }
      }
    } catch {}
  }
  return null
}

export function validateProfile(profile, opts = {}) {
  const { modelId = '', modelFileName = '', projectRoot = '' } = opts
  const issues = []
  const warnings = []
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    return { ok: false, issues: ['缺少 Profile'], warnings: [] }
  }
  const numbers = {}
  for (const key of PROFILE_KEYS) {
    const n = Number(profile[key])
    if (!Number.isFinite(n) || n <= 0) issues.push(`${key} 缺失或不是正数`)
    numbers[key] = n
  }
  if (issues.length === 0) {
    if (!(numbers.p1 <= numbers.p5 && numbers.p5 < numbers.p95 && numbers.p95 <= numbers.p99)) {
      issues.push('音域百分位顺序应为 p1 ≤ p5 < p95 ≤ p99')
    }
    if (profile.p50 != null) {
      const p50 = Number(profile.p50)
      if (!Number.isFinite(p50) || p50 <= 0) issues.push('p50 不是正数')
      else if (p50 < numbers.p5 || p50 > numbers.p95) issues.push('p50 应位于 p5 和 p95 之间')
    }
  }
  if (!profile.id) warnings.push('Profile 缺少 id，导入时会补成模型 id')
  else if (modelId && String(profile.id) !== String(modelId)) warnings.push(`Profile id 与模型 id 不一致（${profile.id} ≠ ${modelId}）`)
  if (profile.model && modelFileName && basename(String(profile.model)) !== modelFileName) {
    warnings.push(`Profile.model 与模型文件名不一致（${basename(String(profile.model))} ≠ ${modelFileName}）`)
  }
  if (profile.promptWav) {
    const raw = String(profile.promptWav)
    const file = isAbsolute(raw) ? raw : resolve(projectRoot || process.cwd(), raw)
    if (!existsSync(file)) warnings.push('Profile 里的参考音频不存在（仅 SoulX 需要）')
  }
  return { ok: issues.length === 0, issues, warnings }
}

function inspectMetadata(dir, modelFileName, modelBytes) {
  const file = join(dir, 'model_metadata.json')
  if (!existsSync(file)) return null
  const data = readJson(file, null)
  if (!data || typeof data !== 'object') return null
  const issues = []
  const warnings = []
  if (data.rvc_version && !/^v[12]$/i.test(String(data.rvc_version))) issues.push('model_metadata.rvc_version 不是 v1 / v2')
  if (data.sample_rate && ![32000, 40000, 48000].includes(Number(data.sample_rate))) issues.push('model_metadata.sample_rate 不是 32k / 40k / 48k')
  const declared = Array.isArray(data.files)
    ? data.files.find((f) => f && basename(String(f.file || '')) === modelFileName)
    : null
  if (declared && Number(declared.bytes) && Number(declared.bytes) !== modelBytes) {
    issues.push('model_metadata 记录的文件大小与实际不一致')
  }
  if (!declared) warnings.push('model_metadata 未列出当前 .pth 文件')
  return {
    ok: issues.length === 0,
    name: String(data.name || ''),
    version: String(data.rvc_version || ''),
    sampleRate: Number(data.sample_rate) || 0,
    epochs: Number(data.epochs) || 0,
    issues,
    warnings,
  }
}

function findModelInDir(dir) {
  const pths = []
  const meta = readJson(join(dir, 'model_metadata.json'), null)
  if (meta && Array.isArray(meta.files)) {
    for (const item of meta.files) {
      const file = item && String(item.file || '')
      if (file.toLowerCase().endsWith('.pth') && existsSync(join(dir, file))) pths.push(join(dir, file))
    }
  }
  const base = join(dir, `${basename(dir)}.pth`)
  if (existsSync(base) && !pths.includes(base)) pths.push(base)
  try {
    for (const name of readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.pth'))) {
      const full = join(dir, name)
      if (!pths.includes(full)) pths.push(full)
    }
  } catch {}
  if (pths.length === 1) return { path: pths[0], candidates: pths }
  if (pths.length > 1) {
    return { path: '', candidates: pths, message: '目录里有多个 .pth，请直接填写具体模型文件路径' }
  }
  return { path: '', candidates: [], message: '目录里没有找到 .pth 模型文件' }
}

function walkIndexFiles(dir, out, depth = 0) {
  if (depth > 3 || out.length >= 200) return
  let entries = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkIndexFiles(full, out, depth + 1)
    else if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.toLowerCase().endsWith('.index')) out.push(full)
  }
}

function findIndexFor(settings, modelFile, meta) {
  const dir = dirname(modelFile)
  const id = baseIdOf(modelFile).toLowerCase()
  const candidates = []
  if (meta && Array.isArray(meta.files)) {
    for (const item of meta.files) {
      const file = item && String(item.file || '')
      if (file.toLowerCase().endsWith('.index') && existsSync(join(dir, file))) candidates.push(join(dir, file))
    }
  }
  const exact = join(dir, `${baseIdOf(modelFile)}.index`)
  if (existsSync(exact)) candidates.unshift(exact)
  try {
    for (const name of readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.index'))) {
      const full = join(dir, name)
      if (!candidates.includes(full)) candidates.push(full)
    }
  } catch {}
  const roots = [
    settings?.rvcDir ? join(settings.rvcDir, 'assets', 'indices') : '',
    settings?.rvcDir ? join(settings.rvcDir, 'logs') : '',
  ].filter(Boolean)
  const directCount = candidates.length
  const pool = []
  for (const root of roots) walkIndexFiles(root, pool)
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const tokenRe = new RegExp(`(^|_)${escaped}(_|\\.index$)`, 'i')
  const linked = pool
    .filter((file) => tokenRe.test(basename(file)))
    .sort((a, b) => {
      const an = basename(a).toLowerCase()
      const bn = basename(b).toLowerCase()
      const ae = an === `${id}.index` ? 0 : 1
      const be = bn === `${id}.index` ? 0 : 1
      return ae - be
    })
  for (const file of linked) if (!candidates.includes(file)) candidates.push(file)
  if (!candidates.length) return null
  const path = candidates[0]
  return { path, fileName: basename(path), bytes: fileSize(path), linked: directCount === 0 }
}

export function inspectModelPath(settings, pluginRoot, rawPath, opts = {}) {
  const input = resolveModelInput(settings, pluginRoot, rawPath)
  const result = {
    ok: false, input, errors: [], warnings: [], model: null, profile: null, index: null, metadata: null,
    library: { alreadyInLibrary: false, modelExists: false },
  }
  if (!input) {
    result.errors.push('模型路径不能为空')
    return result
  }
  if (!existsSync(input)) {
    result.errors.push(`路径不存在：${input}`)
    return result
  }
  let st
  try { st = statSync(input) } catch {
    result.errors.push(`无法读取路径：${input}`)
    return result
  }
  let modelPath = ''
  if (st.isDirectory()) {
    const found = findModelInDir(input)
    if (!found.path) {
      result.errors.push(found.message || '目录里没有找到 .pth 模型文件')
      result.candidates = found.candidates || []
      return result
    }
    modelPath = found.path
  } else if (st.isFile()) {
    modelPath = input
  } else {
    result.errors.push('路径既不是文件也不是目录')
    return result
  }
  const format = inspectModelFile(modelPath)
  const metadata = inspectMetadata(dirname(modelPath), basename(modelPath), format.bytes)
  let modelId = baseIdOf(modelPath)
  if (st.isDirectory()) {
    const fromMeta = String(metadata?.name || '').trim()
    const fromDir = basename(input)
    if (ID_RE.test(fromMeta)) modelId = fromMeta
    else if (ID_RE.test(fromDir)) modelId = fromDir
  }
  if (!ID_RE.test(modelId)) {
    result.errors.push(`模型 id 不合法：${modelId || '(空)'}；只能用字母、数字、下划线、短横线（80 字以内）`)
  }
  result.model = {
    path: modelPath,
    fileName: basename(modelPath),
    id: modelId,
    bytes: format.bytes,
    format,
  }
  result.metadata = metadata
  result.errors.push(...format.issues)
  result.warnings.push(...format.warnings)
  if (metadata) {
    result.errors.push(...metadata.issues)
    result.warnings.push(...metadata.warnings)
  }
  result.index = findIndexFor(settings, modelPath, readJson(join(dirname(modelPath), 'model_metadata.json'), null))
  if (!result.index) result.warnings.push('没有找到同名 .index；index rate 为 0 时仍可生成')
  let profileHit = null
  let profileError = ''
  if (opts.profilePath) {
    const profilePath = resolveModelInput(settings, pluginRoot, opts.profilePath)
    if (!existsSync(profilePath)) {
      profileError = `Profile 路径不存在：${profilePath}`
    } else {
      const data = readProfileFile(profilePath)
      if (!data) profileError = 'Profile 文件不是有效 JSON，或缺少 p1 / p5 / p95 / p99'
      else profileHit = { path: profilePath, data }
    }
  } else if (ID_RE.test(modelId)) {
    profileHit = findProfileFor(settings, pluginRoot, modelPath, modelId)
  }
  const profileValidation = profileHit
    ? validateProfile(profileHit.data, { modelId, modelFileName: basename(modelPath), projectRoot: settings?.projectRoot || pluginRoot })
    : { ok: false, issues: [profileError || '缺少 Profile'], warnings: [] }
  result.profile = {
    path: profileHit?.path || (opts.profilePath ? resolveModelInput(settings, pluginRoot, opts.profilePath) : ''),
    data: profileHit?.data || null,
    validation: profileValidation,
  }
  result.errors.push(...profileValidation.issues)
  result.warnings.push(...profileValidation.warnings)
  const destination = isInsideDir(settings?.modelsDir, modelPath)
  result.library = {
    alreadyInLibrary: destination,
    modelExists: Boolean(settings?.modelsDir && existsSync(join(settings.modelsDir, `${modelId}.pth`))),
    suggestedProfilePath: join(dataDir('profiles'), `${modelId}.json`),
  }
  result.errors = unique(result.errors)
  result.warnings = unique(result.warnings)
  result.ok = Boolean(result.model?.format?.ok && result.profile?.validation?.ok && ID_RE.test(modelId))
  return result
}

function isInsideDir(dir, file) {
  if (!dir) return false
  try { return resolve(dirname(file)) === resolve(dir) } catch { return false }
}

export function importModel(settings, pluginRoot, rawPath, opts = {}) {
  const overwrite = opts.overwrite === true
  const inspection = inspectModelPath(settings, pluginRoot, rawPath, { profilePath: opts.profilePath })
  if (!inspection.model) {
    return { ok: false, code: 'invalid-path', message: inspection.errors[0] || '模型路径不可用', inspection }
  }
  if (!inspection.model.format?.ok) {
    return { ok: false, code: 'bad-format', message: inspection.errors[0] || '模型文件格式未通过', inspection }
  }
  if (!inspection.profile?.validation?.ok) {
    return { ok: false, code: 'bad-profile', message: inspection.errors[0] || 'Profile 未通过校验', inspection }
  }
  const id = inspection.model.id
  const destModel = join(settings.modelsDir, `${id}.pth`)
  if (inspection.library.alreadyInLibrary) {
    return { ok: false, code: 'already-in-library', message: '模型已经在模型库中', inspection }
  }
  if (existsSync(destModel) && !overwrite) {
    return { ok: false, code: 'model-exists', message: `模型库已有同名模型：${destModel}`, inspection }
  }
  try {
    ensureDir(settings.modelsDir)
    copyFileSync(inspection.model.path, destModel)
    let indexPath = ''
    if (inspection.index?.path) {
      const indexDir = join(settings.rvcDir, 'assets', 'indices')
      ensureDir(indexDir)
      indexPath = join(indexDir, `${id}.index`)
      if (resolve(inspection.index.path) !== resolve(indexPath)) copyFileSync(inspection.index.path, indexPath)
    }
    const profileSource = inspection.profile.data || {}
    const promptWav = profileSource.promptWav
      ? (isAbsolute(String(profileSource.promptWav))
        ? String(profileSource.promptWav)
        : resolve(dirname(inspection.profile.path), String(profileSource.promptWav)))
      : ''
    const profile = {
      ...profileSource,
      id,
      model: `${id}.pth`,
      label: profileSource.label || id,
      promptWav: promptWav && existsSync(promptWav) ? promptWav : '',
    }
    const profilePath = join(dataDir('profiles'), `${id}.json`)
    writeJson(profilePath, profile)
    const importedInspection = {
      ...inspection,
      model: {
        ...inspection.model,
        path: destModel,
        fileName: basename(destModel),
        bytes: fileSize(destModel),
        format: {
          ...inspection.model.format,
          path: destModel,
          fileName: basename(destModel),
          bytes: fileSize(destModel),
        },
      },
      profile: { ...inspection.profile, path: profilePath },
      index: indexPath
        ? { path: indexPath, fileName: basename(indexPath), bytes: fileSize(indexPath) }
        : null,
      library: {
        ...inspection.library,
        alreadyInLibrary: true,
        modelExists: true,
        suggestedProfilePath: profilePath,
      },
    }
    return {
      ok: true,
      voiceId: id,
      modelPath: destModel,
      profilePath,
      indexPath,
      inspection: importedInspection,
    }
  } catch (error) {
    return { ok: false, code: 'copy-failed', message: String(error?.message || error), inspection }
  }
}

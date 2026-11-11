import { spawn } from 'node:child_process'
import {
  createReadStream, existsSync, mkdirSync, readdirSync, renameSync, statSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

function tail(text, n = 1200) {
  const s = String(text || '')
  return s.length > n ? s.slice(-n) : s
}

export function run(cmd, args, { cwd, env, onLine, timeoutMs = 0, job } = {}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(cmd, args, {
        cwd,
        env: { ...process.env, ...(env || {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(error)
      return
    }
    if (job) job._child = child
    let stdout = ''
    let stderr = ''
    let buf = ''
    let timer = null
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch {}
        reject(new Error(`命令超时：${basename(cmd)}`))
      }, timeoutMs)
    }
    const feed = (chunk) => {
      buf += chunk.toString('utf8')
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() || ''
      for (const line of lines) if (line && onLine) onLine(line)
    }
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); feed(d) })
    child.stderr.on('data', (d) => { stderr += d.toString('utf8') })
    child.on('error', (error) => {
      if (timer) clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (buf && onLine) onLine(buf)
      if (job && job.cancelled) {
        reject(new Error('已取消'))
        return
      }
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${basename(cmd)} 退出码 ${code}：${tail(stderr || stdout)}`))
    })
  })
}

export async function probeDuration(settings, file) {
  try {
    const { stdout } = await run(settings.ffprobe || 'ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', file,
    ], { timeoutMs: 30000 })
    const value = Number(String(stdout).trim())
    if (Number.isFinite(value) && value > 0) return value
  } catch {}
  // ffprobe 不一定有；从 ffmpeg -i 的 stderr 里读。
  try {
    const { stderr } = await run(settings.ffmpeg || 'ffmpeg', ['-hide_banner', '-i', file], { timeoutMs: 30000 })
    const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr || '')
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  } catch (error) {
    const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(error.message || ''))
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  }
  throw new Error('读不到音频时长')
}

export async function decodeToWav(settings, input, output, { job } = {}) {
  mkdirSync(dirname(output), { recursive: true })
  await run(settings.ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', input, '-ar', '44100', '-ac', '2', output,
  ], { job })
}

function pickStems(dir) {
  const files = readdirSync(dir).filter((n) => /\.wav$/i.test(n))
  const vocals = files.find((n) => /\(vocals\)/i.test(n)) || files.find((n) => /vocals?/i.test(n))
  const inst = files.find((n) => /\(instrumental\)/i.test(n))
    || files.find((n) => /instrumental|no[_-]?vocals|accompaniment/i.test(n))
  if (!vocals || !inst) throw new Error(`人声分离没有产出完整分轨：${files.join(', ') || '(空)'}`)
  return { vocals: join(dir, vocals), inst: join(dir, inst) }
}

export async function separate(settings, input, outDir, { job, report } = {}) {
  if (!settings.separatorExe || !existsSync(settings.separatorExe)) {
    throw new Error('人声分离器未配置：请在设置里填写 audio-separator 路径')
  }
  if (!settings.separatorModelDir || !existsSync(settings.separatorModelDir)) {
    throw new Error('人声分离模型目录未配置：请在设置里填写 separator-models 路径')
  }
  mkdirSync(outDir, { recursive: true })
  for (const old of ['vocals.wav', 'instrumental.wav']) {
    try { if (existsSync(join(outDir, old))) renameSync(join(outDir, old), join(outDir, `${old}.old-${Date.now()}`)) } catch {}
  }
  report?.('分离人声', 0.12, 'BS-Roformer 分离中，可能需要 1–3 分钟')
  await run(settings.separatorExe, [
    input,
    '--model_filename', settings.separatorModel,
    '--model_file_dir', settings.separatorModelDir,
    '--output_dir', outDir,
    '--output_format', 'WAV',
  ], {
    job,
    timeoutMs: 30 * 60_000,
    onLine: (line) => {
      const m = /(\d{1,3})%/.exec(line)
      if (m) report?.('分离人声', 0.12 + 0.42 * (Number(m[1]) / 100), line.slice(-160))
    },
  })
  const { vocals, inst } = pickStems(outDir)
  const vOut = join(outDir, 'vocals.wav')
  const iOut = join(outDir, 'instrumental.wav')
  if (vocals !== vOut) renameSync(vocals, vOut)
  if (inst !== iOut) renameSync(inst, iOut)
  report?.('分离人声', 0.55, '分轨完成')
  return { vocals: vOut, instrumental: iOut }
}

export async function analyze(settings, { vocals, profile, out }, { job, report, progressStart = 0.02, progressEnd = 1 } = {}) {
  const script = join(settings._pluginRoot, 'engine', 'analyze.py')
  report?.('分析 F0', 0.02, 'RMVPE 提取音高')
  await run(settings.pythonPath, [
    script,
    '--audio', vocals,
    '--profile', profile,
    '--rvc-dir', settings.rvcDir,
    '--out', out,
    '--phrase-gap', String(settings.phraseGap),
    '--section-gap', String(settings.sectionGap),
    '--min-phrase', String(settings.minPhrase),
    '--top-db', String(settings.topDb),
  ], {
    job,
    timeoutMs: 20 * 60_000,
    onLine: (line) => {
      const m = /^PROGRESS\s+([\d.]+)\s*(.*)$/.exec(line)
      if (m) report?.('分析 F0', progressStart + (progressEnd - progressStart) * Number(m[1]), m[2] || '')
    },
  })
}

export async function renderVocal(settings, { vocals, model, plan, out }, { job, report } = {}) {
  const script = join(settings._pluginRoot, 'engine', 'render.py')
  report?.('渲染人声', 0.02, '加载 RVC 模型')
  await run(settings.pythonPath, [
    script,
    '--input', vocals,
    '--model', model,
    '--plan', plan,
    '--rvc-dir', settings.rvcDir,
    '--out', out,
    '--protect', String(settings.protect),
    '--rms-mix-rate', String(settings.rmsMixRate),
    '--index-rate', String(settings.indexRate),
    '--crossfade-ms', String(settings.crossfadeMs),
    '--fill-gap', String(settings.fillGap),
  ], {
    job,
    timeoutMs: 60 * 60_000,
    onLine: (line) => {
      const m = /^PROGRESS\s+([\d.]+)\s*(.*)$/.exec(line)
      if (m) report?.('渲染人声', 0.02 + 0.78 * Number(m[1]), m[2] || '')
    },
  })
}

export async function renderSoulx(settings, { vocals, analysis, plan, prompt, out }, { job, report } = {}) {
  const script = join(settings._pluginRoot, 'engine', 'soulx_svc.py')
  report?.('SoulX-SVC', 0.02, '加载 SoulX-Singer SVC 模型')
  await run(settings.soulxPython, [
    script,
    '--input', vocals,
    '--analysis', analysis,
    '--plan', plan,
    '--prompt-wav', prompt,
    '--model', settings.soulxModel,
    '--config', settings.soulxConfig,
    '--soulx-dir', settings.soulxDir,
    '--out', out,
    '--device', settings.soulxDevice,
    '--n-steps', String(settings.soulxSteps),
    '--cfg', String(settings.soulxCfg),
    '--prompt-seconds', String(settings.soulxPromptSeconds),
  ], {
    job,
    timeoutMs: 2 * 60 * 60_000,
    onLine: (line) => {
      const m = /^PROGRESS\s+([\d.]+)\s*(.*)$/.exec(line)
      if (m) report?.('SoulX-SVC', 0.02 + 0.78 * Number(m[1]), m[2] || '')
    },
  })
}

export async function mix(settings, { vocals, instrumental, outWav, outMp3 }, { job, report } = {}) {
  report?.('混音', 0.82, '人声 + 伴奏')
  const hasInst = instrumental && existsSync(instrumental)
  const filter = hasInst
    ? '[0:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0dB[v];'
      + '[1:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=-2dB[i];'
      + '[v][i]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[mix];'
      + '[mix]loudnorm=I=-14:TP=-1.5:LRA=11[out]'
    : '[0:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[mix];'
      + '[mix]loudnorm=I=-14:TP=-1.5:LRA=11[out]'
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', vocals]
  if (hasInst) args.push('-i', instrumental)
  args.push(
    '-filter_complex', filter, '-map', '[out]',
    '-ar', '44100', '-ac', '2', outWav,
  )
  await run(settings.ffmpeg, args, { job, timeoutMs: 20 * 60_000 })
  report?.('导出 MP3', 0.94, '')
  await run(settings.ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', outWav, '-c:a', 'libmp3lame', '-b:a', '320k', outMp3,
  ], { job, timeoutMs: 10 * 60_000 })
}

const MIME = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
}

export function streamFile(req, res, file, fallbackType = 'application/octet-stream') {
  let st
  try { st = statSync(file) } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
  const type = MIME[file.slice(file.lastIndexOf('.')).toLowerCase()] || fallbackType
  const range = req.headers.range
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (m) {
      let start = m[1] === '' ? null : Number(m[1])
      let end = m[2] === '' ? null : Number(m[2])
      if (start === null && end !== null) {
        start = Math.max(0, st.size - end)
        end = st.size - 1
      }
      if (start === null) start = 0
      if (end === null || end >= st.size) end = st.size - 1
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'content-range': `bytes */${st.size}` })
        res.end()
        return
      }
      res.writeHead(206, {
        'content-type': type,
        'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${end}/${st.size}`,
        'content-length': end - start + 1,
      })
      if (req.method === 'HEAD') { res.end(); return }
      createReadStream(file, { start, end }).pipe(res)
      return
    }
  }
  res.writeHead(200, {
    'content-type': type,
    'accept-ranges': 'bytes',
    'content-length': st.size,
  })
  if (req.method === 'HEAD') { res.end(); return }
  createReadStream(file).pipe(res)
}

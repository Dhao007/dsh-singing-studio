import { createWriteStream, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, extname } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { ensureDir } from './store.js'

const fmtSize = (bytes) => (bytes >= 1024 * 1024
  ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
  : `${bytes} B`)

/**
 * 把请求体流式写进 dest。
 * 模型最大 2.6 GB，不能像歌曲上传那样先整个读进内存；超限直接中断并让调用方清理临时文件。
 */
export async function writeUpload(req, dest, maxBytes) {
  let size = 0
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length
      if (size > maxBytes) {
        cb(new Error(`文件比预期大（上限 ${Math.round(maxBytes / 1024 / 1024)} MB）`))
        return
      }
      cb(null, chunk)
    },
  })
  await pipeline(req, counter, createWriteStream(dest))
  return size
}

/**
 * 把用户手动下载的文件放进清单项的目标路径。
 * 目标路径和大小都来自 Host 自己的 downloadManifest，客户端只能给清单 id 和文件名。
 * @returns {Promise<{ ok: boolean, status: number, message?: string, size?: number, target?: string }>}
 */
export async function placeUpload(req, entry, fileName) {
  const want = extname(entry.target).toLowerCase()
  if (!fileName) return { ok: false, status: 400, message: '缺少文件名' }
  if (extname(fileName).toLowerCase() !== want) {
    return { ok: false, status: 400, message: `文件类型不对：这一项需要 ${want} 文件` }
  }
  const expected = Number(entry.size) || 0
  const limit = expected ? expected + 1024 : 4 * 1024 * 1024 * 1024
  const tmp = `${entry.target}.upload`
  try {
    ensureDir(dirname(entry.target))
    const size = await writeUpload(req, tmp, limit)
    if (expected && size !== expected) {
      rmSync(tmp, { force: true })
      return {
        ok: false,
        status: 400,
        message: `文件大小不对：应该 ${fmtSize(expected)}，实际 ${fmtSize(size)}，可能没下载完`,
      }
    }
    // .json 是 HuBERT 配置这种小文件，顺手确认内容没坏；.pt/.bin 只做大小校验。
    if (want === '.json') {
      try { JSON.parse(readFileSync(tmp, 'utf8')) } catch {
        rmSync(tmp, { force: true })
        return { ok: false, status: 400, message: '这个文件不是有效的 JSON，可能下错了' }
      }
    }
    rmSync(entry.target, { force: true })
    renameSync(tmp, entry.target)
    rmSync(`${entry.target}.part`, { force: true })
    return { ok: true, status: 200, size, target: entry.target }
  } catch (error) {
    try { rmSync(tmp, { force: true }) } catch {}
    return { ok: false, status: 400, message: String(error?.message || error) }
  }
}

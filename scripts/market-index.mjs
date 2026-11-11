#!/usr/bin/env node
/**
 * Generate a DSH plugin-market index (format 1) for this plugin.
 *
 * Usage:
 *   node scripts/market-index.mjs --repo OWNER/REPO [--source npm] [--registry URL]
 *   node scripts/market-index.mjs --repo OWNER/REPO --source git --commit SHA [--path 子目录]
 *
 * The default npm source points installations at registry.npmmirror.com:
 * publish to npm first, then the mirror serves the same package.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const zh = JSON.parse(readFileSync(join(root, 'locale', 'zh.json'), 'utf8'))
const en = JSON.parse(readFileSync(join(root, 'locale', 'en.json'), 'utf8'))
const DEFAULT_REGISTRY = 'https://registry.npmmirror.com/'

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const value = process.argv[i + 1]
  return value && !value.startsWith('--') ? value : fallback
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

function resolveRepo() {
  const given = arg('repo')
  if (given) return given
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' }).trim()
    const match = /github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote)
    if (match) return `${match[1]}/${match[2]}`
  } catch {}
  return ''
}

const repo = resolveRepo()
  .replace(/^https?:\/\/github\.com\//, '')
  .replace(/\.git$/, '')
  .replace(/^\/|\/$/g, '')
if (!/^[^/]+\/[^/]+$/.test(repo)) {
  fail('用法：node scripts/market-index.mjs --repo OWNER/REPO [--source npm|git] [--registry URL]\n' +
    'OWNER/REPO 换成真实的 GitHub 仓库，例如 Dhao007/dsh-singing-studio。')
}
if (repo.includes('OWNER')) {
  console.warn('警告：仓库地址还是占位符 OWNER/REPO，发布前记得替换成真实地址。')
}

const sourceType = arg('source', 'npm')
if (sourceType !== 'npm' && sourceType !== 'git') fail('--source 只能是 npm 或 git')

let commit = arg('commit')
if (sourceType === 'git' && !commit) {
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    fail('无法读取 git commit：请先 git commit，或传 --commit <40位sha>')
  }
}
if (sourceType === 'git' && !/^[0-9a-f]{40}$/.test(commit)) {
  fail(`commit 必须是 40 位小写 sha：${commit}`)
}

const directory = arg('path').replace(/^\/|\/$/g, '')
if (directory && !/^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/.test(directory)) {
  fail('--path 必须是相对目录，例如 plugins/dsh-singing-studio')
}

let registry = arg('registry', DEFAULT_REGISTRY)
if (sourceType === 'npm') {
  if (!/^https?:\/\/\S+$/.test(registry)) fail(`--registry 必须是 http(s) 地址：${registry}`)
  if (!registry.endsWith('/')) registry += '/'
}

const repoUrl = `https://github.com/${repo}`
const rawBase = `https://raw.githubusercontent.com/${repo}/main/${directory ? `${directory}/` : ''}`
const author = arg('author')
const dshRange = arg('dsh', pkg.engines?.dsh || '')
const out = resolve(root, arg('out', 'market/index.json'))
const timestamp = Number(arg('timestamp')) || Math.floor(Date.now() / 1000)

const source = sourceType === 'npm'
  ? { type: 'npm', registry }
  : { type: 'git', url: repoUrl, commit, ...(directory ? { path: directory } : {}) }

const index = {
  format: 1,
  title: { zh: '唱歌工作室 · 插件源', en: 'Singing Studio · Plugin Index' },
  description: {
    zh: '唱歌工作室的 DSH 插件市场索引。',
    en: 'DSH plugin-market index for Singing Studio.',
  },
  metadata: {
    categories: { audio: { title: { zh: '音频与音乐', en: 'Audio & Music' } } },
    labels: {
      rvc: { title: { zh: 'RVC', en: 'RVC' } },
      soulx: { title: { zh: 'SoulX', en: 'SoulX' } },
      singing: { title: { zh: '唱歌', en: 'Singing' } },
    },
    sortKeys: { published: { title: { zh: '发布时间', en: 'Published' }, order: 'desc' } },
  },
  plugins: [{
    name: pkg.name,
    title: { zh: zh.meta.title, en: en.meta.title },
    description: { zh: zh.meta.description, en: en.meta.description },
    icon: `${rawBase}assets/icon-180.png`,
    ...(author ? { author } : {}),
    homepage: repoUrl,
    repository: { url: repoUrl, ...(directory ? { directory } : {}) },
    metadata: {
      category: 'audio',
      keywords: ['dsh', 'dsh-plugin', 'rvc', 'soulx', 'singing', '翻唱', '音色训练'],
      labels: ['rvc', 'soulx', 'singing'],
      sortKeys: { published: timestamp },
    },
    versions: [{
      version: pkg.version,
      publishTimestamp: timestamp,
      source,
      ...(dshRange ? { engines: { dsh: dshRange } } : {}),
    }],
  }],
}

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
console.log(`写入 ${out}`)
console.log(`插件 ${pkg.name}@${pkg.version} -> ${sourceType === 'npm' ? `npm (${registry})` : `${repoUrl}${directory ? `#${directory}` : ''} @ ${commit}`}`)
console.log(`在 DSH 的「发现」里添加：https://raw.githubusercontent.com/${repo}/main/${directory ? `${directory}/` : ''}market/index.json`)

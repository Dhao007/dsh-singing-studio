import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { run } from './deps.js'
import { dataDir, readJson } from './store.js'
import {
  importModel, inspectModelPath, resolveModelInput, validateProfile,
} from './model-inspect.js'

/**
 * 用用户提供的训练数据为已有 .pth 生成音域 Profile。
 * 不重新训练模型；跑 RMVPE 统计有声帧分位数后，必要时把权重 / 索引 / Profile 复制进模型库。
 */
export async function buildModelProfile(settings, pluginRoot, opts = {}) {
  const { modelPath = '', datasetPath = '', label = '' } = opts
  if (!String(modelPath).trim()) return { ok: false, message: '请先填写已有模型权重路径' }
  if (!String(datasetPath).trim()) return { ok: false, message: '请先填写训练数据路径' }

  const inspection = inspectModelPath(settings, pluginRoot, modelPath)
  if (!inspection.model) {
    return { ok: false, code: 'invalid-model', message: inspection.errors[0] || '模型路径不可用', inspection }
  }
  if (!inspection.model.format?.ok) {
    return { ok: false, code: 'bad-format', message: inspection.errors[0] || '模型文件格式未通过', inspection }
  }
  const id = inspection.model.id
  const dataset = resolveModelInput(settings, pluginRoot, datasetPath)
  if (!existsSync(dataset)) {
    return { ok: false, code: 'bad-dataset', message: `训练数据路径不存在：${dataset}`, inspection }
  }
  const python = String(settings.pythonPath || '')
  if (!python || !existsSync(python)) {
    return { ok: false, code: 'no-python', message: 'RVC Python 环境还没准备好，先在「环境安装」完成准备', inspection }
  }
  const rmvpe = join(settings.rvcDir || '', 'assets', 'rmvpe', 'rmvpe.pt')
  if (!existsSync(rmvpe)) {
    return { ok: false, code: 'no-rmvpe', message: '缺少 RMVPE 音高模型，先在「环境安装」完成准备', inspection }
  }
  const script = join(pluginRoot, 'engine', 'build_profile.py')
  if (!existsSync(script)) {
    return { ok: false, code: 'no-script', message: '缺少 build_profile.py，插件文件不完整', inspection }
  }

  const profilePath = join(dataDir('profiles'), `${id}.json`)
  const profileLabel = label || inspection.profile?.data?.label || id
  try {
    await run(python, [
      script,
      '--dataset', dataset,
      '--name', id,
      '--label', profileLabel,
      '--model', `${id}.pth`,
      '--source', dataset,
      '--out', profilePath,
      '--rvc-dir', settings.rvcDir,
    ], { timeoutMs: 10 * 60_000 })
  } catch (error) {
    return {
      ok: false,
      code: 'profile-failed',
      message: String(error?.message || error),
      inspection,
    }
  }
  const profile = readJson(profilePath, null)
  const profileValidation = validateProfile(profile, {
    modelId: id,
    modelFileName: `${id}.pth`,
    projectRoot: settings.projectRoot || pluginRoot,
  })
  if (!profile || !profileValidation.ok) {
    return {
      ok: false,
      code: 'bad-profile',
      message: profileValidation.issues[0] || '生成的 Profile 未通过校验',
      profile,
      profilePath,
      inspection,
    }
  }

  if (!inspection.library.alreadyInLibrary) {
    const imported = importModel(settings, pluginRoot, modelPath, { profilePath })
    if (!imported.ok) {
      return {
        ok: false,
        code: imported.code || 'import-failed',
        message: imported.message || '模型加入模型库失败',
        profile,
        profilePath,
        inspection: imported.inspection || inspection,
      }
    }
    return {
      ...imported,
      ok: true,
      profile,
      profilePath,
      profileValidation,
      imported: true,
    }
  }

  const nextInspection = inspectModelPath(settings, pluginRoot, modelPath)
  return {
    ok: true,
    voiceId: id,
    modelPath: inspection.model.path,
    profilePath,
    profile,
    profileValidation,
    imported: false,
    inspection: nextInspection,
  }
}

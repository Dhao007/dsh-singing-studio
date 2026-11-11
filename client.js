// 唱歌工作室 · 网页半边：小卡片分页 + 制作台 + 时间轴 + 方案表 + 试听。
// 只调用 Host 的 /singing/api/*，不直接碰文件或 Python。

window.__ModuleLoader__.load({
  id: 'dsh-singing-studio',
  factory: (require) => {
    const React = require('react')
    const { useState, useEffect, useLayoutEffect, useRef, useCallback } = React
    const h = React.createElement
    const API = '/singing/api'
    const PANEL_ID = 'singing-studio'
    const PAGE_KEY = 'singing-studio.page'
    // DSH 切到别的面板时 StudioPage 会卸载（main 槽只挂当前面板），
    // 所以工作区快照单独存一份，切回来再按 id 从 Host 取回分析/成品。
    const WORKSPACE_KEY = 'singing-studio.workspace.v1'
    const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

    const get = (p) => fetch(API + p, { cache: 'no-store' }).then((r) => r.json()).catch((e) => ({ ok: false, message: '连不上插件：' + e.message }))
    const post = (p, body) => fetch(API + p, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
    }).then((r) => r.json()).catch((e) => ({ ok: false, message: '连不上插件：' + e.message }))

    // 工作区快照：只放 id 和轻量数据（分析结果、成品音频都按 id 重新取）。
    const readWorkspace = () => {
      try {
        const raw = localStorage.getItem(WORKSPACE_KEY)
        if (!raw) return null
        const data = JSON.parse(raw)
        if (!data || data.v !== 1) return null
        return data
      } catch { return null }
    }
    const saveWorkspace = (data) => {
      try { localStorage.setItem(WORKSPACE_KEY, JSON.stringify(data)) } catch {}
    }

    const pct = (v) => `${(Math.max(0, Math.min(1, Number(v) || 0)) * 100).toFixed(1)}%`
    const fmtTime = (s) => {
      const v = Math.max(0, Number(s) || 0)
      const m = Math.floor(v / 60)
      const r = v - m * 60
      return `${m}:${r.toFixed(1).padStart(4, '0')}`
    }
    const fmtShort = (s) => {
      const v = Math.max(0, Number(s) || 0)
      const m = Math.floor(v / 60)
      return `${m}:${String(Math.floor(v - m * 60)).padStart(2, '0')}`
    }
    const fmtStamp = (ts) => {
      const v = Number(ts)
      if (!v) return ''
      const d = new Date(v)
      const now = new Date()
      const hh = String(d.getHours()).padStart(2, '0')
      const mm = String(d.getMinutes()).padStart(2, '0')
      if (d.toDateString() === now.toDateString()) return `${hh}:${mm}`
      return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hh}:${mm}`
    }
    const fmtAgo = (ts) => {
      if (!ts) return ''
      const d = Math.max(0, Date.now() - ts)
      if (d < 60000) return '刚刚'
      if (d < 3600000) return `${Math.floor(d / 60000)} 分钟前`
      if (d < 86400000) return `${Math.floor(d / 3600000)} 小时前`
      return `${Math.floor(d / 86400000)} 天前`
    }
    const fmtEta = (sec) => {
      const v = Number(sec)
      if (!Number.isFinite(v) || v < 0) return '计算中'
      const s = Math.round(v)
      if (s < 60) return `${s} 秒`
      const m = Math.floor(s / 60)
      if (m < 60) return `${m} 分 ${String(s % 60).padStart(2, '0')} 秒`
      return `${Math.floor(m / 60)} 小时 ${String(m % 60).padStart(2, '0')} 分`
    }
    const planLevelLabel = (level) => ({
      global: '全局八度', section: '分段八度', phrase: '乐句八度', none: '原曲 0',
    }[level] || '方案')
    const fmtMB = (bytes) => {
      const v = Number(bytes) || 0
      if (v >= 1024 * 1024 * 1024) return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`
      if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`
      if (v >= 1024) return `${(v / 1024).toFixed(1)} KB`
      return `${v} B`
    }
    const noteName = (hz) => {
      if (!(hz > 0)) return '—'
      const m = Math.round(69 + 12 * Math.log2(hz / 440))
      return NOTES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1)
    }
    const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12)
    const cx = (...a) => a.filter(Boolean).join(' ')
    const css = (el, name, fallback) => {
      try { return getComputedStyle(el).getPropertyValue(name).trim() || fallback } catch { return fallback }
    }
    const jobLabel = (status) => ({ queued: '排队中', running: '进行中', done: '已完成', error: '失败', cancelled: '已取消' }[status] || status || '未知')
    const jobType = (type) => ({ analyze: '分析', render: '生成', setup: '环境准备', train: '训练' }[type] || type || '任务')
    const statusTone = (status) => (status === 'done' ? 'good' : status === 'error' || status === 'cancelled' ? 'warn' : '')

    const ICON = {
      overview: 'M3.5 10.5 12 3l8.5 7.5M5.5 9.3V21h13V9.3M9.5 21v-6h5v6',
      studio: 'M12 3.2a3.1 3.1 0 0 1 3.1 3.1v5.4a3.1 3.1 0 0 1-6.2 0V6.3A3.1 3.1 0 0 1 12 3.2zM5.6 11.2a6.4 6.4 0 0 0 12.8 0M12 17.6V21M8.8 21h6.4',
      timeline: 'M3 12h2.4l1.8-6.5 3.4 13 2.6-8.5 1.9 4.4H21',
      plans: 'M12 3 3.5 7.6 12 12.2l8.5-4.6L12 3zM3.5 12 12 16.6 20.5 12M3.5 16.4 12 21l8.5-4.6',
      env: 'M8.5 3v3M15.5 3v3M8.5 18v3M15.5 18v3M3 8.5h3M3 15.5h3M18 8.5h3M18 15.5h3M6.5 6.5h11v11h-11zM10 10h4v4h-4z',
      settings: 'M4 7h8M16 7h4M4 12h4M12 12h8M4 17h10M18 17h2M14 5v4M10 10v4M14 15v4',
      train: 'M4 19V9M9 19V5M14 19v-7M19 19v-4M3 21h18',
      upload: 'M12 16V4M7.5 8.5 12 4l4.5 4.5M5 14v5h14v-5',
      spark: 'M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3zM18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z',
      play: 'M9 6.5v11l9-5.5-9-5.5z',
      speaker: 'M4 9.5h3.5L12 6v12l-4.5-3.5H4zM16 9a4.5 4.5 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11',
      check: 'M5 12.5 9.5 17 19 7.5',
      alert: 'M12 4 3.5 20h17L12 4zM12 9v5M12 17.2v.1',
      clock: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM12 7v5.5l3.5 2',
      info: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM12 10.5V17M12 7.2v.1',
      download: 'M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14',
      refresh: 'M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5',
      arrow: 'M5 12h14M13 6l6 6-6 6',
      chevron: 'M6 9l6 6 6-6',
    }

    const PAGES = [
      { id: 'env', label: '环境安装', icon: ICON.env, hint: '依赖与一键准备' },
      { id: 'train', label: 'RVC训练', icon: ICON.train, hint: '训练音色模型' },
      { id: 'studio', label: '制作台', icon: ICON.studio, hint: '歌曲、翻唱与队列' },
      { id: 'settings', label: '设置', icon: ICON.settings, hint: '通用设置' },
    ]
    const PAGE_IDS = new Set(PAGES.map((p) => p.id))
    // 老版本的页 id 迁移到新的四页布局；时间轴 / 方案迁到制作台内部视图。
    const readSavedPage = () => {
      try {
        const saved = localStorage.getItem(PAGE_KEY)
        const map = { overview: 'studio', timeline: 'studio', plans: 'studio' }
        const page = map[saved] || saved
        if (PAGE_IDS.has(page)) {
          return {
            page,
            view: saved === 'timeline' ? 'timeline' : saved === 'plans' ? 'plans' : '',
          }
        }
      } catch {}
      return { page: 'env', view: '' }
    }

    const TRAIN_DEFAULTS = {
      datasetPath: '',
      name: '',
      label: '',
      sr: '48k',
      version: 'v2',
      epochs: 20,
      batchSize: 4,
      saveEvery: 5,
      per: 3.7,
      f0Method: 'rmvpe',
      nP: 2,
      index: true,
      pretrained: true,
      device: 'auto',
    }
    const trainFormOf = (saved) => ({ ...TRAIN_DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) })

    const SETTING_GROUPS = [
      {
        id: 'soulx',
        page: 'studio',
        title: 'SoulX-SVC 零样本参数',
        desc: 'SoulX 的设备与推理参数。',
        items: [
          { key: 'soulxPromptWav', label: '默认参考音频', wide: true },
          { key: 'soulxDevice', label: '设备', select: [['auto', 'auto · 自动'], ['mps', 'mps · Apple GPU'], ['cuda', 'cuda · NVIDIA'], ['cpu', 'cpu · 仅 CPU']] },
          { key: 'soulxSteps', label: 'SoulX 步数', type: 'number', step: '1' },
          { key: 'soulxCfg', label: 'SoulX CFG', type: 'number', step: '0.1' },
          { key: 'soulxPromptSeconds', label: '参考音频截取（秒）', type: 'number', step: '1' },
        ],
      },
      {
        id: 'netease',
        page: 'studio',
        title: '网易云下载',
        desc: '免费歌不用登录；会员 / 版权歌填 MUSIC_U。',
        items: [
          { key: 'neteaseCookie', label: 'Cookie（MUSIC_U，可选）', type: 'password', wide: true, placeholder: '没填就留空；已保存的不会显示' },
        ],
      },
      {
        id: 'plan',
        page: 'studio',
        title: '八度规划与混音',
        desc: '覆盖率和变调参数。',
        items: [
          { key: 'targetCoverage', label: '目标覆盖率（0–1）', type: 'number', step: '0.01' },
          { key: 'maxOctaves', label: '候选八度上限（±N）', type: 'number', step: '1' },
          { key: 'protect', label: 'protect（0–0.5）', type: 'number', step: '0.01' },
          { key: 'rmsMixRate', label: 'rms mix rate', type: 'number', step: '0.01' },
          { key: 'crossfadeMs', label: '交叉淡化（ms）', type: 'number', step: '10' },
          { key: 'fillGap', label: '短停顿并入上一段（秒）', type: 'number', step: '0.1' },
        ],
      },
      {
        id: 'analysis',
        page: 'studio',
        title: 'F0 分析与乐句',
        desc: '影响分析时的乐句切分和覆盖率统计。',
        items: [
          { key: 'phraseGap', label: '乐句间隔（秒）', type: 'number', step: '0.05' },
          { key: 'sectionGap', label: '段落间隔（秒）', type: 'number', step: '0.1' },
          { key: 'minPhrase', label: '最短乐句（秒）', type: 'number', step: '0.1' },
          { key: 'topDb', label: '静音阈值（dB）', type: 'number', step: '1' },
        ],
      },
      {
        id: 'download',
        page: 'settings',
        title: '下载',
        desc: '下载模型和依赖时使用的代理；默认留空直连。',
        items: [
          { key: 'proxy', label: '下载代理（可选）', wide: true },
        ],
      },
      {
        id: 'general',
        page: 'settings',
        title: '通用',
        desc: '插件行为与上传限制。',
        items: [
          { key: 'autoWarmup', label: '自动预加载 RVC', select: [[true, '开启'], [false, '关闭']] },
          { key: 'maxUploadMB', label: '上传大小上限（MB）', type: 'number', step: '10' },
        ],
      },
    ]

    const cssText = `
    .ss-page{height:100%;overflow:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
    .ss-page button{font:inherit}
    .ss-inner{max-width:1280px;margin:0 auto;padding:24px 28px 56px}
    .ss-hero{position:relative;overflow:hidden;display:flex;align-items:center;gap:18px;padding:22px 24px;border:1px solid var(--dsw-alias-border-l1);border-radius:20px;background:radial-gradient(120% 160% at 0 0,color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent),transparent 58%),radial-gradient(90% 140% at 100% 0,color-mix(in srgb,var(--dsw-alias-state-success-primary) 9%,transparent),transparent 55%),var(--dsw-alias-bg-layer-1);box-shadow:0 10px 30px rgba(0,0,0,.06)}
    .ss-hero:after{content:"";position:absolute;right:-42px;bottom:-78px;width:240px;height:240px;border-radius:50%;background:radial-gradient(circle,color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent),transparent 70%);pointer-events:none}
    .ss-hero-mark{width:58px;height:58px;border-radius:18px;display:grid;place-items:center;flex:none;color:var(--dsw-alias-bg-base);background:linear-gradient(145deg,var(--dsw-alias-brand-primary),color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,var(--dsw-alias-state-success-primary)));box-shadow:0 10px 24px color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,transparent);position:relative;z-index:1}
    .ss-hero-mark svg circle{fill:var(--dsw-alias-brand-primary)}
    .ss-hero-body{flex:1;min-width:0;position:relative;z-index:1}
    .ss-eyebrow{font-size:10px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
    .ss-title{font-size:25px;line-height:1.2;font-weight:750;letter-spacing:.2px;margin:4px 0 0}
    .ss-sub{color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:1.6;margin:6px 0 0;max-width:720px}
    .ss-hero-tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:11px}
    .ss-chip{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:4px 9px;border-radius:999px;font-size:11px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 76%,transparent)}
    .ss-chip b{font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px}
    .ss-chip .ss-mini-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}
    .ss-chip .ss-mini-dot.ok{background:var(--dsw-alias-state-success-primary)}
    .ss-hero-side{display:flex;flex-direction:column;align-items:flex-end;gap:8px;flex:none;position:relative;z-index:1}
    .ss-version{font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
    .ss-pills{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
    .ss-pill{display:inline-flex;align-items:center;gap:5px;font-size:11px;padding:4px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1)}
    .ss-pill:before{content:"";width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}
    .ss-pill.ok{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 35%,transparent)}
    .ss-pill.ok:before{background:var(--dsw-alias-state-success-primary)}
    .ss-pill.bad{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent)}
    .ss-pill.bad:before{background:var(--dsw-alias-state-error-primary)}
    .ss-nav{position:sticky;top:0;z-index:8;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:var(--dsh-frame-top-clearance,24px) 0 16px;padding:8px;border-radius:16px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 86%,transparent);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}
    .ss-nav:before{content:"";position:absolute;left:-28px;right:-28px;bottom:calc(100% + 1px);height:var(--dsh-frame-top-clearance,24px);background:var(--dsw-alias-bg-base);pointer-events:none}
    .ss-nav-card{position:relative;display:flex;align-items:center;gap:10px;min-width:0;min-height:64px;padding:10px 12px;border-radius:14px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left;transition:border-color .15s,background .15s,box-shadow .15s,transform .15s}
    .ss-nav-card:hover{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,var(--dsw-alias-border-l1));transform:translateY(-1px);box-shadow:0 8px 20px rgba(0,0,0,.07)}
    .ss-nav-card.on{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 65%,transparent);background:radial-gradient(120% 150% at 0 0,color-mix(in srgb,var(--dsw-alias-brand-primary) 11%,transparent),transparent 72%),var(--dsw-alias-bg-layer-1);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 11%,transparent)}
    .ss-nav-card.on:after{content:"";position:absolute;left:14px;right:14px;bottom:-1px;height:2px;border-radius:2px;background:linear-gradient(90deg,var(--dsw-alias-brand-primary),color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,transparent))}
    .ss-nav-card:focus-visible{outline:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 24%,transparent)}
    .ss-nav-icon{width:34px;height:34px;border-radius:11px;display:grid;place-items:center;flex:none;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);transition:background .15s,color .15s}
    .ss-nav-card.on .ss-nav-icon{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-brand-primary)}
    .ss-nav-copy{display:flex;flex-direction:column;gap:2px;min-width:0}
    .ss-nav-label{font-size:13px;font-weight:650;letter-spacing:.1px}
    .ss-nav-hint{font-size:10.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .ss-nav-card.on .ss-nav-hint{color:color-mix(in srgb,var(--dsw-alias-brand-primary) 62%,var(--dsw-alias-label-secondary))}
    .ss-player{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 14px;border-radius:14px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 35%,var(--dsw-alias-border-l1));background:linear-gradient(90deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent),transparent 55%),var(--dsw-alias-bg-layer-1);margin-bottom:14px}
    .ss-player-label{display:flex;align-items:center;gap:8px;flex:none;font-size:12px;font-weight:650;white-space:nowrap;color:var(--dsw-alias-brand-primary)}
    .ss-player audio{display:none}
    .ss-player-body{display:flex;align-items:center;gap:8px;flex:1 1 auto;min-width:160px}
    .ss-play-btn{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;flex:none;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;padding:0}
    .ss-play-btn:hover{border-color:var(--dsw-alias-brand-primary)}
    .ss-play-btn svg{display:block}
    .ss-player-time{font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap;min-width:42px;text-align:center}
    .ss-seek{position:relative;flex:1;min-width:120px;height:22px;display:flex;align-items:center;cursor:pointer;touch-action:none;outline:none;-webkit-tap-highlight-color:transparent}
    .ss-seek-rail{position:absolute;left:0;right:0;height:5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#1d2637);border:1px solid var(--dsw-alias-border-l1,#26324a)}
    .ss-seek-fill{position:absolute;left:0;height:5px;border-radius:999px;background:var(--dsw-alias-brand-primary,#6ea8ff);pointer-events:none;transition:width .08s linear}
    .ss-seek-thumb{position:absolute;width:11px;height:11px;border-radius:50%;background:var(--dsw-alias-brand-primary,#6ea8ff);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary,#6ea8ff) 16%,transparent);transform:translateX(-50%);pointer-events:none;transition:width .12s,height .12s}
    .ss-seek:hover .ss-seek-thumb,.ss-seek.dragging .ss-seek-thumb{width:13px;height:13px;box-shadow:0 0 0 5px color-mix(in srgb,var(--dsw-alias-brand-primary,#6ea8ff) 20%,transparent)}
    .ss-seek:focus-visible{box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary,#6ea8ff) 24%,transparent);border-radius:999px}
    .ss-seek.dragging .ss-seek-fill{transition:none}
    .ss-seek.disabled{opacity:.45;cursor:default}
    .ss-seek-tip{position:absolute;bottom:22px;transform:translateX(-50%);padding:2px 6px;border-radius:6px;font-size:10px;font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--dsw-alias-label-primary,#e8eeff);background:var(--dsw-alias-bg-overlay,#1b2233);border:1px solid var(--dsw-alias-border-l2,#33405c);pointer-events:none;z-index:2}
    .ss-player-actions{display:flex;gap:8px;flex-wrap:wrap}
    .ss-player-side{display:flex;align-items:center;gap:8px;flex-wrap:nowrap;flex:0 0 auto;min-width:0}
    .ss-player-note{flex-basis:100%;display:flex;align-items:center;gap:6px;font-size:10.5px;line-height:1.4;color:var(--dsw-alias-state-warn-primary,#ffb45c)}
    .ss-render-pick{height:24px;max-width:170px;font-size:10.5px;padding:0 6px;flex:none}
    .ss-seg{display:inline-flex;gap:2px;padding:2px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);flex:none}
    .ss-seg-btn{height:24px;padding:0 8px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:10.5px;cursor:pointer}
    .ss-seg-btn.on{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.08)}
    .ss-seg-btn:disabled{opacity:.4;cursor:not-allowed}
    .ss-search-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
    .ss-search-row .ss-input{flex:1;min-width:200px}
    .ss-search-list{display:flex;flex-direction:column;gap:1px;margin-top:10px;max-height:310px;overflow:auto}
    .ss-search-item{display:flex;align-items:center;gap:9px;padding:9px 6px;border-bottom:1px solid var(--dsw-alias-border-l1);min-width:0;border-radius:8px}
    .ss-search-item:hover{background:var(--dsw-alias-bg-layer-2)}
    .ss-search-item:last-child{border-bottom:0}
    .ss-search-main{flex:1;min-width:0}
    .ss-search-title{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .ss-search-alias{font-size:10.5px;color:var(--dsw-alias-label-secondary);font-weight:400;margin-left:6px}
    .ss-search-meta{font-size:10.5px;color:var(--dsw-alias-label-secondary);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .ss-page-head{display:flex;align-items:center;justify-content:space-between;gap:14px;margin:2px 0 14px;flex-wrap:wrap}
    .ss-page-head-main{display:flex;align-items:center;gap:11px;min-width:0}
    .ss-page-head-icon{width:38px;height:38px;border-radius:12px;display:grid;place-items:center;flex:none;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 11%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-brand-primary);border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent)}
    .ss-page-head-title{font-size:18px;font-weight:700;margin:0;letter-spacing:.1px}
    .ss-page-head-desc{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);margin:3px 0 0}
    .ss-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:16px;padding:18px;box-shadow:0 1px 2px rgba(0,0,0,.03)}
    .ss-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px;flex-wrap:wrap}
    .ss-card-heading{min-width:0}
    .ss-card-title{display:flex;align-items:center;gap:7px;margin:0;font-size:14px;font-weight:700;letter-spacing:.1px}
    .ss-card-title svg{color:var(--dsw-alias-brand-primary);flex:none}
    .ss-card-desc{font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary);margin:4px 0 0}
    .ss-banner{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:15px 17px;border-radius:16px;border:1px dashed color-mix(in srgb,var(--dsw-alias-brand-primary) 38%,var(--dsw-alias-border-l1));background:linear-gradient(90deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,transparent),transparent 65%),var(--dsw-alias-bg-layer-1);margin-bottom:14px}
    .ss-banner-mark{width:38px;height:38px;border-radius:12px;display:grid;place-items:center;flex:none;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 13%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-brand-primary)}
    .ss-banner-body{flex:1;min-width:200px}
    .ss-banner-title{font-size:13px;font-weight:700}
    .ss-banner-desc{font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary);margin-top:2px}
    .ss-grid{display:grid;gap:14px}
    .ss-g2{grid-template-columns:repeat(2,minmax(0,1fr))}
    .ss-g3{grid-template-columns:repeat(3,minmax(0,1fr))}
    .ss-main-side{grid-template-columns:minmax(0,1fr) 320px;align-items:start}
    .ss-overview-grid{grid-template-columns:minmax(0,1.3fr) minmax(0,.9fr);align-items:start}
    .ss-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:0 0 14px}
    .ss-metric{position:relative;overflow:hidden;background:linear-gradient(150deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,transparent),transparent 62%),var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;padding:13px 15px}
    .ss-metric .k{font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:6px}
    .ss-metric .v{font-size:20px;font-weight:720;letter-spacing:.1px;font-variant-numeric:tabular-nums}
    .ss-metric .h{font-size:10.5px;color:var(--dsw-alias-label-secondary);margin-top:4px;line-height:1.45}
    .ss-flow{display:flex;flex-direction:column;gap:2px}
    .ss-flow-row{display:flex;align-items:center;gap:11px;width:100%;padding:10px 9px;border:0;border-radius:11px;background:transparent;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;transition:background .12s}
    .ss-flow-row:hover{background:var(--dsw-alias-bg-layer-2)}
    .ss-flow-num{width:27px;height:27px;border-radius:9px;display:grid;place-items:center;flex:none;font-size:11px;font-weight:700;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1)}
    .ss-flow-row.done .ss-flow-num{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 13%,var(--dsw-alias-bg-layer-1));border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 32%,transparent);color:var(--dsw-alias-state-success-primary)}
    .ss-flow-main{flex:1;min-width:0}
    .ss-flow-name{display:block;font-size:12.5px;font-weight:600}
    .ss-flow-meta{display:block;font-size:10.5px;color:var(--dsw-alias-label-secondary);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .ss-flow-arrow{color:var(--dsw-alias-label-secondary);flex:none;opacity:.6}
    .ss-actions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
    .ss-action{display:flex;flex-direction:column;gap:8px;padding:16px;border-radius:14px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
    .ss-action-num{width:26px;height:26px;border-radius:9px;display:grid;place-items:center;font-size:11px;font-weight:700;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-brand-primary);border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 25%,transparent)}
    .ss-action h4{margin:0;font-size:13px;font-weight:700}
    .ss-action p{margin:0;font-size:11px;line-height:1.65;color:var(--dsw-alias-label-secondary);flex:1}
    .ss-action .ss-btn{margin-top:2px;justify-content:center}
    .ss-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 14px}
    .ss-field{display:flex;flex-direction:column;gap:5px;min-width:0}
    .ss-field.wide{grid-column:1/-1}
    .ss-field label{font-size:11px;color:var(--dsw-alias-label-secondary)}
    .ss-field-hint{font-size:10.5px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
    .ss-input,.ss-select{height:36px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:0 10px;font-size:12.5px;outline:none;min-width:0;width:100%;box-sizing:border-box}
    .ss-select{cursor:pointer}
    .ss-input:focus,.ss-select:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 13%,transparent)}
    .ss-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px;padding:0 14px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap;text-decoration:none;transition:border-color .12s,filter .12s,background .12s}
    .ss-btn:hover{border-color:var(--dsw-alias-brand-primary)}
    .ss-btn:focus-visible{outline:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent)}
    .ss-btn.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
    .ss-btn.primary:hover{filter:brightness(1.06)}
    .ss-btn.ghost{background:transparent}
    .ss-btn:disabled{opacity:.42;cursor:not-allowed;filter:none}
    .ss-btn.sm{height:28px;padding:0 10px;font-size:11.5px;border-radius:7px}
    .ss-backends{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:12px}
    .ss-backend{display:flex;align-items:flex-start;gap:10px;padding:12px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;transition:border-color .12s,box-shadow .12s,background .12s}
    .ss-backend:hover{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,var(--dsw-alias-border-l1))}
    .ss-backend.on{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 62%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 5%,var(--dsw-alias-bg-layer-2))}
    .ss-backend-radio{width:14px;height:14px;border-radius:50%;border:1.5px solid var(--dsw-alias-border-l2);flex:none;margin-top:2px;position:relative}
    .ss-backend.on .ss-backend-radio{border-color:var(--dsw-alias-brand-primary)}
    .ss-backend.on .ss-backend-radio:after{content:"";position:absolute;inset:2.5px;border-radius:50%;background:var(--dsw-alias-brand-primary)}
    .ss-backend-body{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}
    .ss-backend-title{font-size:12.5px;font-weight:650}
    .ss-backend-desc{font-size:10.5px;line-height:1.55;color:var(--dsw-alias-label-secondary)}
    .ss-inline-meta{display:flex;gap:7px;flex-wrap:wrap;margin-top:11px}
    .ss-history{display:flex;flex-direction:column;gap:1px;margin-top:2px}
    .ss-history-row{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:11.5px;color:var(--dsw-alias-label-secondary);padding:8px 4px;border-bottom:1px solid var(--dsw-alias-border-l1)}
    .ss-history-row:last-child{border-bottom:0}
    .ss-history-main{display:flex;flex-direction:column;gap:1px;min-width:0}
    .ss-history-name{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .ss-history-meta{font-size:10px;color:var(--dsw-alias-label-secondary)}
    .ss-canvas-wrap{position:relative;margin-top:2px}
    .ss-canvas{display:block;width:100%;border-radius:12px;background:var(--dsw-alias-bg-layer-2);cursor:crosshair}
    .ss-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:10.5px;color:var(--dsw-alias-label-secondary);margin-top:9px;line-height:1.6}
    .ss-legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px}
    .ss-phrase-bar{display:flex;gap:6px;overflow-x:auto;padding:8px 0 2px;margin-top:6px;scrollbar-width:thin}
    .ss-phrase{flex:none;display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10.5px;cursor:pointer;white-space:nowrap}
    .ss-phrase b{font-weight:700;color:var(--dsw-alias-label-primary);font-size:10px}
    .ss-phrase:hover{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,var(--dsw-alias-border-l1))}
    .ss-phrase.on{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 62%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 9%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}
    .ss-phrase.on b{color:var(--dsw-alias-brand-primary)}
    .ss-phrase-info{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:4px;flex-wrap:wrap}
    .ss-tooltip{position:absolute;pointer-events:none;z-index:3;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 8px;font-size:11px;color:var(--dsw-alias-label-primary);box-shadow:0 8px 24px rgba(0,0,0,.18);white-space:nowrap;transform:translate(10px,-50%)}
    .ss-audio{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:12px}
    .ss-audio audio{height:34px;flex:1;min-width:260px}
    .ss-section-title{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:13px;font-weight:700;margin:0 0 10px}
    .ss-table-wrap{overflow:auto}
    .ss-table{width:100%;border-collapse:collapse;font-size:11.5px;min-width:560px}
    .ss-table th{text-align:left;font-weight:500;color:var(--dsw-alias-label-secondary);padding:8px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}
    .ss-table td{padding:9px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:middle}
    .ss-table tbody tr{cursor:pointer;transition:background .12s}
    .ss-table tbody tr:hover td{background:var(--dsw-alias-bg-layer-2)}
    .ss-table tr.sel td{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent)}
    .ss-table tr:last-child td{border-bottom:0}
    .ss-tag{display:inline-flex;align-items:center;padding:2px 7px;border-radius:999px;font-size:10.5px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
    .ss-tag.good{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 35%,transparent)}
    .ss-tag.warn{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 35%,transparent)}
    .ss-radio{width:14px;height:14px;accent-color:var(--dsw-alias-brand-primary)}
    .ss-note{font-size:11.5px;line-height:1.7;color:var(--dsw-alias-label-secondary)}
    .ss-note b{color:var(--dsw-alias-label-primary)}
    .ss-warn{font-size:11.5px;line-height:1.65;color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 25%,transparent);border-radius:9px;padding:9px 11px;margin-top:10px}
    .ss-warn .ss-btn{margin-left:8px}
    .ss-job{display:flex;flex-direction:column;gap:7px;margin-top:12px;padding:10px 12px;border-radius:11px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
    .ss-job-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .ss-job-stage{font-size:11px;color:var(--dsw-alias-label-secondary);min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .ss-job-pct{font-size:11px;font-weight:650;font-variant-numeric:tabular-nums;color:var(--dsw-alias-brand-primary)}
    .ss-job-msg{font-size:10.5px;color:var(--dsw-alias-label-secondary);line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .ss-bar{flex:1;min-width:90px;height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;border:1px solid var(--dsw-alias-border-l1)}
    .ss-bar i{display:block;height:100%;background:linear-gradient(90deg,var(--dsw-alias-brand-primary),color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,var(--dsw-alias-state-success-primary)));transition:width .25s ease}
    .ss-ring{position:relative;display:grid;place-items:center;flex:0 0 auto;border-radius:50%}
    .ss-ring svg{position:absolute;inset:0}
    .ss-ring-track{stroke:color-mix(in srgb,var(--dsw-alias-border-l2) 85%,transparent)}
    .ss-ring-fill{stroke:var(--dsw-alias-brand-primary);transition:stroke-dashoffset .4s linear}
    .ss-ring-text{position:relative;font-size:9.5px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--dsw-alias-brand-primary);line-height:1}
    .ss-ring.loading{cursor:pointer;animation:ss-pulse 1.6s ease-in-out infinite}
    .ss-ring.done .ss-ring-fill{stroke:var(--dsw-alias-state-success-primary)}
    .ss-ring.done .ss-ring-text{color:var(--dsw-alias-state-success-primary)}
    .ss-ring.bad .ss-ring-fill{stroke:var(--dsw-alias-state-error-primary)}
    .ss-ring.bad .ss-ring-text{color:var(--dsw-alias-state-error-primary)}
    .ss-device-act{display:flex;align-items:center;gap:8px;margin-top:9px}
    @keyframes ss-pulse{0%,100%{opacity:1}50%{opacity:.68}}
    @media (prefers-reduced-motion:reduce){.ss-ring.loading{animation:none}}
    .ss-empty{padding:42px 22px;text-align:center;border:1px dashed var(--dsw-alias-border-l2);border-radius:16px;background:linear-gradient(160deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 4%,transparent),transparent 60%),var(--dsw-alias-bg-layer-1)}
    .ss-empty-icon{width:44px;height:44px;border-radius:14px;display:grid;place-items:center;margin:0 auto 12px;color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 11%,var(--dsw-alias-bg-layer-1));border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent)}
    .ss-empty h3{margin:0 0 7px;font-size:16px}
    .ss-empty p{margin:0 auto;max-width:600px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.75}
    .ss-empty-actions{display:flex;justify-content:center;gap:9px;flex-wrap:wrap;margin-top:15px}
    .ss-steps{display:flex;justify-content:center;gap:8px;flex-wrap:wrap;margin-top:16px}
    .ss-step{padding:6px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}
    .ss-settings-sections{display:flex;flex-direction:column}
    .ss-settings-section{border-top:1px solid var(--dsw-alias-border-l1);padding:4px 0}
    .ss-settings-section:first-child{border-top:0}
    .ss-settings-section summary{display:flex;align-items:center;justify-content:space-between;gap:12px;list-style:none;cursor:pointer;padding:10px 2px;border-radius:8px}
    .ss-settings-section summary::-webkit-details-marker{display:none}
    .ss-settings-summary{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;min-width:0}
    .ss-settings-title{font-size:12.5px;font-weight:650}
    .ss-settings-desc{font-size:10.5px;color:var(--dsw-alias-label-secondary);line-height:1.5}
    .ss-settings-chevron{color:var(--dsw-alias-label-secondary);flex:none;transition:transform .15s}
    .ss-settings-section[open] .ss-settings-chevron{transform:rotate(180deg)}
    .ss-settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 14px;padding:4px 2px 14px}
    .ss-settings .ss-field{min-width:0}
    .ss-savebar{position:sticky;bottom:14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:14px;padding:10px 14px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 90%,transparent);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);box-shadow:0 10px 30px rgba(0,0,0,.12);z-index:5}
    .ss-savebar.inline{position:static;margin-top:10px;box-shadow:none}
    .ss-savebar-text{font-size:11.5px;color:var(--dsw-alias-label-secondary);flex:1;min-width:140px}
    .ss-savebar-text.dirty{color:var(--dsw-alias-state-warn-primary);font-weight:600}
    .ss-savebar-actions{display:flex;gap:8px;flex-wrap:wrap}
    .ss-check{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
    .ss-env-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 18px;margin-top:4px}
    .ss-env-item{display:flex;gap:9px;align-items:flex-start;min-width:0;padding:8px 8px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
    .ss-dot{width:8px;height:8px;border-radius:50%;margin-top:5px;flex:0 0 auto;background:var(--dsw-alias-state-error-primary)}
    .ss-dot.ok{background:var(--dsw-alias-state-success-primary)}
    .ss-dot.opt{background:var(--dsw-alias-label-secondary);opacity:.5}
    .ss-env-name{font-size:11.5px;font-weight:600}
    .ss-env-detail{font-size:10.5px;line-height:1.45;color:var(--dsw-alias-label-secondary);word-break:break-all}
    .ss-dl-list{display:flex;flex-direction:column;gap:8px;margin-top:10px}
    .ss-dl-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:9px 10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
    .ss-dl-row.bad{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 6%,var(--dsw-alias-bg-layer-2))}
    .ss-dl-main{display:flex;flex-direction:column;gap:3px;min-width:220px;flex:1}
    .ss-dl-title{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:600;flex-wrap:wrap}
    .ss-dl-path{font-size:10.5px;line-height:1.45;color:var(--dsw-alias-label-secondary);word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
    .ss-dl-actions{display:flex;gap:6px;flex-wrap:wrap}
    .ss-dl-drop{flex:0 0 100%;display:flex;align-items:center;gap:8px;padding:7px 10px;border:1px dashed var(--dsw-alias-border-l2);border-radius:9px;font-size:10.5px;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:border-color .12s,background .12s,color .12s}
    .ss-dl-drop:hover,.ss-dl-drop.on{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent);color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,transparent)}
    .ss-dl-drop.busy{cursor:progress;color:var(--dsw-alias-brand-primary)}
    .ss-dl-drop .ss-bar{flex:1;min-width:60px;height:5px;margin-left:4px}
    .ss-tag.bad{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent)}
    .ss-song-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(205px,1fr));gap:9px;margin-top:10px}
    .ss-song{display:flex;flex-direction:column;gap:5px;min-width:0;padding:11px 12px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;transition:border-color .12s,background .12s}
    .ss-song:hover{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,var(--dsw-alias-border-l1))}
    .ss-song.on{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 65%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 9%,var(--dsw-alias-bg-layer-2))}
    .ss-song-name{font-size:12.5px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .ss-song-meta{font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
    .ss-song-tags{display:flex;gap:5px;flex-wrap:wrap;margin-top:2px}
    .ss-queue-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
    .ss-queue-row:last-child{border-bottom:0}
    .ss-queue-main{display:flex;flex-direction:column;gap:4px;min-width:180px;flex:1}
    .ss-queue-title{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .ss-cover-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
    .ss-cover-row:last-child{border-bottom:0}
    .ss-cover-main{display:flex;flex-direction:column;gap:3px;min-width:190px;flex:1}
    .ss-cover-title{font-size:12px;font-weight:600}
    .ss-cover-meta{font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
    .ss-cover-row audio{height:30px;max-width:260px}
    .ss-tabs{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 14px;padding:5px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);width:fit-content;max-width:100%}
    .ss-tab{height:30px;padding:0 14px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;cursor:pointer}
    .ss-tab:hover{color:var(--dsw-alias-label-primary)}
    .ss-tab.on{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}
    .ss-train-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px;margin-top:12px}
    .ss-train-stat{display:flex;flex-direction:column;gap:3px;padding:9px 11px;border-radius:11px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);min-width:0}
    .ss-train-stat .k{font-size:10px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
    .ss-train-stat .v{font-size:17px;font-weight:720;font-variant-numeric:tabular-nums;letter-spacing:.1px}
    .ss-train-stat .h{font-size:9.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .ss-train-stat.fit .v{color:var(--dsw-alias-brand-primary)}
    .ss-train-path{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    .ss-train-path .ss-input{flex:1;min-width:220px}
    .ss-spark{display:block;width:100%;height:58px;margin-top:10px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
    .ss-help{font-size:10.5px;line-height:1.55;color:var(--dsw-alias-label-secondary)}
    .ss-train-check{font-size:11px;line-height:1.55;margin-top:8px;color:var(--dsw-alias-label-secondary)}
    .ss-train-check.ok{color:var(--dsw-alias-state-success-primary)}
    .ss-train-check.bad{color:var(--dsw-alias-state-warn-primary)}
    .ss-train-result .ss-kv{display:grid;grid-template-columns:auto 1fr;gap:5px 12px;font-size:11.5px}
    .ss-train-result .ss-kv .k{color:var(--dsw-alias-label-secondary)}
    .ss-train-result .ss-kv .v{word-break:break-all}
    .ss-env-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;align-items:center}
    .ss-device-grid{display:grid;grid-template-columns:1fr;gap:9px}
    .ss-device{padding:11px 12px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
    .ss-device .k{font-size:10.5px;color:var(--dsw-alias-label-secondary);margin-bottom:4px}
    .ss-device .v{font-size:12.5px;font-weight:650;line-height:1.4}
    .ss-device .h{font-size:10px;color:var(--dsw-alias-label-secondary);margin-top:3px}
    .ss-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:40;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 16px;font-size:12.5px;box-shadow:0 12px 36px rgba(0,0,0,.22);max-width:70vw}
    .ss-toast.bad{color:var(--dsw-alias-state-error-primary)}
    @media (max-width:1180px){.ss-nav{position:static;padding:0;margin:16px 0;background:transparent;backdrop-filter:none;-webkit-backdrop-filter:none}.ss-nav:before{display:none}.ss-nav{grid-template-columns:repeat(4,minmax(0,1fr))}.ss-main-side{grid-template-columns:1fr}.ss-overview-grid{grid-template-columns:1fr}.ss-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}
    @media (max-width:900px){.ss-actions{grid-template-columns:1fr}.ss-hero{align-items:flex-start;flex-wrap:wrap}.ss-hero-side{align-items:flex-start;width:100%}.ss-pills{justify-content:flex-start}.ss-inner{padding:20px 20px 46px}}
    @media (max-width:760px){.ss-player-side{flex-wrap:wrap}.ss-player-body{min-width:100%}.ss-form-grid{grid-template-columns:1fr}.ss-backends{grid-template-columns:1fr}.ss-settings-grid{grid-template-columns:1fr}.ss-env-grid{grid-template-columns:1fr}.ss-g2,.ss-g3{grid-template-columns:1fr}.ss-card{padding:16px}.ss-nav{grid-template-columns:repeat(2,minmax(0,1fr))}.ss-train-stats{grid-template-columns:repeat(2,minmax(0,1fr))}}
    @media (max-width:520px){.ss-inner{padding:16px 14px 40px}.ss-hero{padding:18px 16px;border-radius:16px}.ss-hero-mark{width:48px;height:48px;border-radius:15px}.ss-title{font-size:22px}.ss-metrics{grid-template-columns:1fr}.ss-nav{gap:8px}.ss-nav-card{padding:9px 10px;min-height:58px}.ss-nav-icon{width:30px;height:30px;border-radius:9px}.ss-page-head{align-items:flex-start;flex-direction:column}.ss-pills{justify-content:flex-start}}
    @media (prefers-reduced-motion:reduce){.ss-page *{transition:none!important}}
    `

    function NavIcon({ d, size = 16 }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
      }, h('path', { d }))
    }

    function Card({ title, desc, icon, right, children, className, style }) {
      const head = title || right
        ? h('div', { className: 'ss-card-head' },
          h('div', { className: 'ss-card-heading' },
            title ? h('h3', { className: 'ss-card-title' }, icon ? h(NavIcon, { d: icon, size: 16 }) : null, title) : null,
            desc ? h('p', { className: 'ss-card-desc' }, desc) : null,
          ),
          right || null,
        )
        : null
      return h('section', { className: cx('ss-card', className), style }, head, children)
    }

    function PageIntro({ icon, title, desc, right }) {
      return h('div', { className: 'ss-page-head' },
        h('div', { className: 'ss-page-head-main' },
          h('span', { className: 'ss-page-head-icon' }, h(NavIcon, { d: icon, size: 19 })),
          h('div', null,
            h('h2', { className: 'ss-page-head-title' }, title),
            desc ? h('p', { className: 'ss-page-head-desc' }, desc) : null,
          ),
        ),
        right || null,
      )
    }

    function Metric({ label, value, hint }) {
      return h('div', { className: 'ss-metric' },
        h('div', { className: 'k' }, label),
        h('div', { className: 'v' }, value),
        hint ? h('div', { className: 'h' }, hint) : null,
      )
    }

    function Empty({ icon, title, desc, actions }) {
      return h('div', { className: 'ss-empty' },
        h('span', { className: 'ss-empty-icon' }, h(NavIcon, { d: icon || ICON.info, size: 22 })),
        h('h3', null, title),
        desc ? h('p', null, desc) : null,
        actions ? h('div', { className: 'ss-empty-actions' }, actions) : null,
      )
    }

    function JobProgress({ job, onCancel }) {
      if (!job) return null
      const percent = Math.round((job.progress || 0) * 100)
      const started = Number(job.startedAt) || 0
      const elapsed = job.status === 'running' && started ? Math.max(0, (Date.now() - started) / 1000) : 0
      const eta = job.status === 'running' && job.progress > 0.03 && elapsed > 5
        ? elapsed * (1 - job.progress) / job.progress
        : null
      return h('div', { className: 'ss-job' },
        h('div', { className: 'ss-job-top' },
          h('span', { className: 'ss-tag ' + statusTone(job.status) }, jobLabel(job.status)),
          h('span', { className: 'ss-job-stage' }, `${jobType(job.type)} · ${job.stage || '准备中'}`),
          h('span', { className: 'ss-job-pct' }, `${percent}%`),
          (job.status === 'running' || job.status === 'queued') && onCancel
            ? h('button', { className: 'ss-btn sm ghost', onClick: onCancel }, '取消')
            : null,
        ),
        h('div', { className: 'ss-bar' }, h('i', { style: { width: `${percent}%` } })),
        job.message || eta != null
          ? h('div', { className: 'ss-job-msg' },
            job.message || '',
            eta != null ? `${job.message ? ' · ' : ''}预计剩余 ${fmtEta(eta)}` : '')
          : null,
      )
    }

    /**
     * 一条待下载文件：下载线路 + 目标路径 + 放置框。
     * 放置框接受拖拽或点击选择，文件直接 POST 给 Host 写进目标路径，不经过浏览器存储。
     */
    function EnvFileRow({ entry, failed, uploading, onUpload, onCopy }) {
      const inputRef = useRef(null)
      const [drag, setDrag] = useState(false)
      const active = Boolean(uploading && uploading.id === entry.id)
      const percent = active ? Math.round((uploading.pct || 0) * 100) : 0
      const pick = () => { if (!active) inputRef.current?.click() }
      return h('div', { className: cx('ss-dl-row', failed && 'bad', active && 'busy') },
        h('div', { className: 'ss-dl-main' },
          h('div', { className: 'ss-dl-title' },
            entry.label,
            h('span', { className: 'ss-tag ' + (entry.present ? 'good' : failed ? 'bad' : 'warn') },
              entry.present ? '已就位' : failed ? '下载失败' : '待下载'),
            entry.category ? h('span', { className: 'ss-tag' }, entry.category) : null,
            entry.size ? h('span', { className: 'ss-help' }, fmtMB(entry.size)) : null,
            Number(entry.partial) > 0 ? h('span', { className: 'ss-tag warn' }, `已下载 ${fmtMB(entry.partial)}，可续传`) : null,
          ),
          h('div', { className: 'ss-dl-path' }, entry.target),
        ),
        h('div', { className: 'ss-dl-actions' },
          h('button', { type: 'button', className: 'ss-btn sm ghost', onClick: () => onCopy(entry.target, '路径') }, '复制路径'),
          (entry.urls || []).map((url, i) => h('a', {
            key: url, className: 'ss-btn sm' + (i === 0 ? '' : ' ghost'),
            href: url, target: '_blank', rel: 'noreferrer',
          }, i === 0 ? '下载' : `线路 ${i + 1}`)),
        ),
        !entry.present ? h(React.Fragment, null,
          h('div', {
            className: cx('ss-dl-drop', drag && 'on', active && 'busy'),
            role: 'button',
            tabIndex: 0,
            'aria-label': `把下载好的 ${entry.label} 放进目标路径`,
            onClick: pick,
            onKeyDown: (e) => {
              if ((e.key === 'Enter' || e.key === ' ') && !active) { e.preventDefault(); pick() }
            },
            onDragOver: (e) => { e.preventDefault(); if (!active) setDrag(true) },
            onDragLeave: () => setDrag(false),
            onDrop: (e) => {
              e.preventDefault()
              setDrag(false)
              const file = e.dataTransfer?.files?.[0]
              if (file && !active) onUpload(entry, file)
            },
          },
            h(NavIcon, { d: ICON.upload, size: 13 }),
            active ? `正在写入… ${percent}%` : '下载好后，把文件拖到这里，或点击选择',
            active ? h('span', { className: 'ss-bar' }, h('i', { style: { width: `${percent}%` } })) : null,
          ),
          h('input', {
            ref: inputRef, type: 'file', style: { display: 'none' },
            onChange: (e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file && !active) onUpload(entry, file)
            },
          }),
        ) : null,
      )
    }

    /**
     * 小圆圈百分比：加载中显示环形进度 + 数字，成功后变绿固定 100%。
     * 加载中点击圆圈本身也能暂停。
     */
    function WarmupRing({ warmup, onStop, size = 36 }) {
      const done = warmup.status === 'done'
      const failed = warmup.status === 'error'
      const loading = warmup.status === 'loading' || warmup.status === 'cancelling'
      const pct = done ? 100 : Math.round((warmup.progress || 0) * 100)
      const radius = (size - 6) / 2
      const circumference = 2 * Math.PI * radius
      const offset = circumference * (1 - pct / 100)
      const center = size / 2
      return h('div', {
        className: cx('ss-ring', done && 'done', failed && 'bad', loading && 'loading'),
        style: { width: size, height: size },
        title: loading ? '点击暂停加载' : done ? '已加载' : '',
        role: loading ? 'button' : 'img',
        tabIndex: loading ? 0 : undefined,
        'aria-label': `加载进度 ${pct}%`,
        onClick: loading ? onStop : undefined,
        onKeyDown: loading ? (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onStop() }
        } : undefined,
      },
        h('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, 'aria-hidden': true },
          h('circle', { className: 'ss-ring-track', cx: center, cy: center, r: radius, fill: 'none', strokeWidth: 3 }),
          h('circle', {
            className: 'ss-ring-fill', cx: center, cy: center, r: radius, fill: 'none', strokeWidth: 3,
            strokeDasharray: circumference, strokeDashoffset: offset, strokeLinecap: 'round',
            transform: `rotate(-90 ${center} ${center})`,
          }),
        ),
        h('span', { className: 'ss-ring-text' }, `${pct}%`),
      )
    }

    /** 设备卡片里的预加载 / 暂停 / 卸载操作。 */
    function DeviceActions({ backend, warmup, loaded, busy, unloading, onPreload, onStop, onUnload }) {
      const label = backend === 'soulx' ? 'SoulX' : 'RVC'
      const loading = Boolean(warmup && (warmup.status === 'loading' || warmup.status === 'cancelling'))
      const showRing = Boolean(warmup && (loading || warmup.status === 'done' || warmup.status === 'error'))
      return h('div', { className: 'ss-device-act' },
        showRing ? h(WarmupRing, { warmup, onStop }) : null,
        loading
          ? h('button', {
            type: 'button', className: 'ss-btn sm ghost', onClick: onStop,
            disabled: warmup.status === 'cancelling',
          }, warmup.status === 'cancelling' ? '暂停中…' : '暂停')
          : loaded
            ? h('button', {
              type: 'button', className: 'ss-btn sm ghost', onClick: onUnload,
              disabled: busy || unloading,
            }, unloading ? '卸载中…' : '卸载模型')
            : warmup && warmup.status === 'done'
              ? null
              : h('button', {
                type: 'button', className: 'ss-btn sm', onClick: onPreload,
                disabled: busy,
              }, `预加载 ${label}`),
      )
    }

    function FitSpark({ history }) {
      const rows = (history || []).filter((x) => x && x.fit != null)
      if (rows.length < 2) {
        return h('div', { className: 'ss-help', style: { marginTop: 8 } }, '拟合度曲线会在第 2 轮结束后出现。')
      }
      const W = 100
      const H = 40
      const points = rows.map((row, i) => {
        const x = rows.length < 2 ? 0 : (i / (rows.length - 1)) * W
        const y = H - (Math.max(0, Math.min(100, Number(row.fit) || 0)) / 100) * H
        return [Math.round(x * 100) / 100, Math.round(y * 100) / 100]
      })
      const last = points[points.length - 1]
      const line = points.map((p) => p.join(',')).join(' ')
      return h('svg', { className: 'ss-spark', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': '拟合度曲线' },
        [25, 50, 75].map((v) => h('line', {
          key: 'g' + v, x1: 0, x2: W, y1: H - (v / 100) * H, y2: H - (v / 100) * H,
          stroke: 'var(--dsw-alias-border-l1)', strokeWidth: 0.3, vectorEffect: 'non-scaling-stroke',
        })),
        h('polyline', {
          points: line, fill: 'none', stroke: 'var(--dsw-alias-brand-primary)',
          strokeWidth: 1.6, strokeLinejoin: 'round', strokeLinecap: 'round', vectorEffect: 'non-scaling-stroke',
        }),
        h('circle', { cx: last[0], cy: last[1], r: 1.8, fill: 'var(--dsw-alias-brand-primary)' }),
      )
    }

    function TrainProgress({ job, onCancel }) {
      if (!job) return null
      const detail = job.detail || {}
      const percent = Math.round((job.progress || 0) * 100)
      const total = Number(detail.totalEpochs) || 0
      const epoch = Number(detail.epoch) || 0
      const fit = detail.fit == null ? '—' : `${Number(detail.fit).toFixed(1)}%`
      const loss = detail.loss == null ? '—' : Number(detail.loss).toFixed(1)
      const eta = job.status === 'done' ? '已完成' : job.status === 'error' ? '—' : fmtEta(detail.etaSec)
      const live = job.status === 'queued' || job.status === 'running'
      return h('div', { className: 'ss-job', style: { marginTop: 14 } },
        h('div', { className: 'ss-job-top' },
          h('span', { className: 'ss-tag ' + statusTone(job.status) }, jobLabel(job.status)),
          h('span', { className: 'ss-job-stage' }, `训练 · ${job.stage || '准备中'}`),
          h('span', { className: 'ss-job-pct' }, `${percent}%`),
          live && onCancel ? h('button', { className: 'ss-btn sm ghost', onClick: onCancel }, '取消训练') : null,
        ),
        h('div', { className: 'ss-bar' }, h('i', { style: { width: `${percent}%` } })),
        h('div', { className: 'ss-train-stats' },
          h('div', { className: 'ss-train-stat' },
            h('span', { className: 'k' }, '训练轮次'),
            h('span', { className: 'v' }, total ? `${epoch}/${total}` : '—'),
            h('span', { className: 'h' }, live ? '每轮更新拟合度' : '训练结束'),
          ),
          h('div', { className: 'ss-train-stat' },
            h('span', { className: 'k' }, '预计剩余'),
            h('span', { className: 'v' }, eta),
            h('span', { className: 'h' }, '按已完成轮次线性估算'),
          ),
          h('div', { className: 'ss-train-stat fit' },
            h('span', { className: 'k' }, '拟合度'),
            h('span', { className: 'v' }, fit),
            h('span', { className: 'h' }, '由 mel loss 换算'),
          ),
          h('div', { className: 'ss-train-stat' },
            h('span', { className: 'k' }, 'mel loss'),
            h('span', { className: 'v' }, loss),
            h('span', { className: 'h' }, '越低越好'),
          ),
        ),
        h(FitSpark, { history: detail.history || [] }),
        job.message ? h('div', { className: 'ss-job-msg', style: { marginTop: 8 } }, job.message) : null,
        h('div', { className: 'ss-help', style: { marginTop: 8 } },
          '拟合度 = 100 × (1 − e^(−18 / mel loss))，只用来观察训练趋势，不代表绝对音质；切换到其他面板不会中断训练。',
        ),
        job.status === 'error' && job.error ? h('div', { className: 'ss-warn', style: { marginTop: 8 } }, job.error) : null,
      )
    }

    function SettingsGroup({ group, defaultOpen, children }) {
      const [open, setOpen] = useState(Boolean(defaultOpen))
      return h('details', {
        className: 'ss-settings-section',
        open,
        onToggle: (e) => { const next = e.currentTarget.open; if (next !== open) setOpen(next) },
      },
        h('summary', null,
          h('span', { className: 'ss-settings-summary' },
            h('span', { className: 'ss-settings-title' }, group.title),
            h('span', { className: 'ss-settings-desc' }, group.desc),
          ),
          h('span', { className: 'ss-settings-chevron' }, h(NavIcon, { d: ICON.chevron, size: 14 })),
        ),
        open ? h('div', { className: 'ss-settings-grid' }, children) : null,
      )
    }

    function Timeline({ analysis, plan, profile, playhead, phrase, onSeek }) {
      const wrapRef = useRef(null)
      const canvasRef = useRef(null)
      const [size, setSize] = useState({ w: 900, h: 390 })
      const [hover, setHover] = useState(null)
      const [tick, setTick] = useState(0)
      const dragRef = useRef(false)

      useEffect(() => {
        const el = wrapRef.current
        if (!el) return undefined
        const ro = new ResizeObserver(() => setSize({ w: Math.max(320, el.clientWidth || 900), h: 390 }))
        ro.observe(el)
        return () => ro.disconnect()
      }, [])
      useEffect(() => {
        const mo = new MutationObserver(() => setTick((v) => v + 1))
        mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
        return () => mo.disconnect()
      }, [])

      useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas || !analysis) return
        const ctx = canvas.getContext('2d')
        const dpr = window.devicePixelRatio || 1
        const W = size.w
        const H = size.h
        canvas.width = Math.round(W * dpr)
        canvas.height = Math.round(H * dpr)
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, W, H)

        const L = 56, R = 16, T = 18, B = 62
        const pw = Math.max(10, W - L - R)
        const ph = Math.max(10, H - T - B)
        const dur = Math.max(0.1, analysis.duration || 1)
        const fMin = 70, fMax = 1200
        const xOf = (t) => L + (Math.max(0, Math.min(dur, t)) / dur) * pw
        const yOf = (hz) => {
          const v = (Math.log(Math.max(fMin, Math.min(fMax, hz))) - Math.log(fMin)) / (Math.log(fMax) - Math.log(fMin))
          return T + ph * (1 - v)
        }
        const bg = css(canvas, '--dsw-alias-bg-layer-2', '#131a2a')
        const line = css(canvas, '--dsw-alias-border-l1', '#26324a')
        const label = css(canvas, '--dsw-alias-label-primary', '#e8eeff')
        const dim = css(canvas, '--dsw-alias-label-secondary', '#8fa2c4')
        const brand = css(canvas, '--dsw-alias-brand-primary', '#6ea8ff')
        const warn = css(canvas, '--dsw-alias-state-warn-primary', '#ffb45c')
        const error = css(canvas, '--dsw-alias-state-error-primary', '#ff6b7a')
        const good = css(canvas, '--dsw-alias-state-success-primary', '#56d6a8')

        ctx.fillStyle = bg
        ctx.fillRect(0, 0, W, H)

        // 音域带
        const band = (lo, hi, color, alpha) => {
          const y1 = yOf(hi), y2 = yOf(lo)
          ctx.save()
          ctx.globalAlpha = alpha
          ctx.fillStyle = color
          ctx.fillRect(L, y1, pw, y2 - y1)
          ctx.restore()
        }
        band(profile.p1, profile.p99, warn, 0.055)
        band(profile.p5, profile.p95, good, 0.095)

        // 横向音名网格
        ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
        ctx.textAlign = 'right'
        ctx.textBaseline = 'middle'
        for (let m = 36; m <= 84; m++) { // C2..C6
          const hz = midiHz(m)
          if (hz < fMin || hz > fMax) continue
          const y = yOf(hz)
          ctx.strokeStyle = line
          ctx.globalAlpha = m % 12 === 0 ? 0.9 : 0.35
          ctx.lineWidth = 1
          ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + pw, y); ctx.stroke()
          ctx.globalAlpha = 1
          if (m % 12 === 0) {
            ctx.fillStyle = dim
            ctx.fillText(noteName(hz), L - 8, y)
          }
        }
        // 时间网格
        const step = dur > 180 ? 30 : dur > 90 ? 20 : 10
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        for (let t = 0; t <= dur; t += step) {
          const x = xOf(t)
          ctx.strokeStyle = line
          ctx.globalAlpha = 0.45
          ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, T + ph); ctx.stroke()
          ctx.globalAlpha = 1
          ctx.fillStyle = dim
          ctx.fillText(fmtTime(t), x, T + ph + 7)
        }

        // 音域带边界
        const hline = (hz, color, dash) => {
          const y = yOf(hz)
          ctx.save()
          ctx.strokeStyle = color
          ctx.globalAlpha = 0.8
          ctx.lineWidth = 1
          ctx.setLineDash(dash || [])
          ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + pw, y); ctx.stroke()
          ctx.restore()
        }
        hline(profile.p5, good, [4, 4])
        hline(profile.p95, good, [4, 4])
        hline(profile.p1, warn, [2, 4])
        hline(profile.p99, warn, [2, 4])

        // 越界红色阴影（原曲）
        const stateOf = (hz, shift) => {
          const g = hz * Math.pow(2, (shift || 0) / 12)
          if (g >= profile.p5 && g <= profile.p95) return 0
          if (g >= profile.p1 && g <= profile.p99) return 1
          return 2
        }
        const shade = (shiftFor, alpha) => {
          let start = -1
          let cur = -1
          const flush = (end) => {
            if (start < 0) return
            if (cur > 0) {
              ctx.save()
              ctx.globalAlpha = cur === 2 ? alpha * 1.6 : alpha
              ctx.fillStyle = cur === 2 ? error : warn
              const x1 = xOf(start / 100), x2 = xOf(end / 100)
              ctx.fillRect(x1, T, Math.max(1, x2 - x1), ph)
              ctx.restore()
            }
            start = -1
          }
          for (let i = 0; i < analysis.f0.length; i++) {
            const f = analysis.f0[i]
            const st = f > 0 ? stateOf(f, shiftFor(i)) : 0
            if (st !== cur) {
              flush(i)
              cur = st
              start = i
            }
          }
          flush(analysis.f0.length)
        }
        shade(() => 0, 0.055)

        // 乐句切分 + 选中高亮
        ctx.save()
        ctx.strokeStyle = line
        ctx.globalAlpha = 0.14
        ctx.setLineDash([1, 4])
        for (const p of analysis.phrases || []) {
          const x = xOf(p.start)
          ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, T + ph); ctx.stroke()
        }
        ctx.restore()
        if (phrase) {
          const x1 = xOf(phrase.start), x2 = xOf(phrase.end)
          ctx.save()
          ctx.fillStyle = brand
          ctx.globalAlpha = 0.13
          ctx.fillRect(x1, T, Math.max(1, x2 - x1), ph)
          ctx.strokeStyle = brand
          ctx.globalAlpha = 0.7
          ctx.lineWidth = 1
          ctx.setLineDash([])
          ctx.beginPath()
          ctx.moveTo(x1, T); ctx.lineTo(x1, T + ph)
          ctx.moveTo(x2, T); ctx.lineTo(x2, T + ph)
          ctx.stroke()
          ctx.restore()
        }

        // 原曲 F0 曲线（按状态着色）
        const drawCurve = (shiftFor, mode) => {
          let run = []
          let st = -1
          const flush = () => {
            if (run.length > 1) {
              const color = mode === 'plan' ? label : st === 0 ? brand : st === 1 ? warn : error
              ctx.save()
              ctx.strokeStyle = color
              ctx.globalAlpha = mode === 'plan' ? 0.9 : 0.95
              ctx.lineWidth = mode === 'plan' ? 1.4 : 1.5
              ctx.setLineDash(mode === 'plan' ? [5, 4] : [])
              ctx.beginPath()
              for (let k = 0; k < run.length; k++) {
                const [x, y] = run[k]
                if (k === 0) ctx.moveTo(x, y)
                else ctx.lineTo(x, y)
              }
              ctx.stroke()
              ctx.restore()
            }
            run = []
          }
          for (let i = 0; i < analysis.f0.length; i++) {
            const f = analysis.f0[i]
            if (!(f > 0)) { flush(); st = -1; continue }
            const s = shiftFor(i)
            const hz = f * Math.pow(2, s / 12)
            const st2 = mode === 'plan' ? 0 : stateOf(f, 0)
            if (st2 !== st) { flush(); st = st2 }
            run.push([xOf(i / 100), yOf(hz)])
          }
          flush()
        }
        const planShift = (i) => {
          if (!plan || !Array.isArray(plan.shifts)) return 0
          for (const s of plan.shifts) if (i >= s.from && i < s.to) return s.semitones
          return 0
        }
        drawCurve(() => 0, 'base')
        if (plan && plan.shifts) drawCurve(planShift, 'plan')

        // section 边界
        ctx.save()
        ctx.strokeStyle = dim
        ctx.globalAlpha = 0.35
        ctx.setLineDash([2, 5])
        for (const s of analysis.sections || []) {
          const x = xOf(s.start)
          ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, T + ph); ctx.stroke()
        }
        ctx.restore()

        // 覆盖率热力条
        const stripY = H - 20
        const bucket = 0.5
        const buckets = Math.max(1, Math.ceil(dur / bucket))
        for (let b = 0; b < buckets; b++) {
          const t0 = b * bucket
          const t1 = Math.min(dur, t0 + bucket)
          const i0 = Math.floor(t0 * 100)
          const i1 = Math.max(i0 + 1, Math.ceil(t1 * 100))
          let num = 0, den = 0
          if (analysis.voiced) {
            for (let i = i0; i < i1 && i < analysis.voiced.length; i++) {
              if (!analysis.voiced[i]) continue
              const f = analysis.f0[i]
              const g = f * Math.pow(2, planShift(i) / 12)
              den++
              if (g >= profile.p5 && g <= profile.p95) num++
            }
          }
          const v = den ? num / den : 0
          const x1 = xOf(t0), x2 = xOf(t1)
          ctx.fillStyle = `hsl(${Math.round(v * 130)}, 68%, 48%)`
          ctx.globalAlpha = den ? 0.85 : 0.15
          ctx.fillRect(x1, stripY, Math.max(1, x2 - x1 - 0.6), 8)
        }
        ctx.globalAlpha = 1

        // 变调轨
        if (plan && Array.isArray(plan.shifts)) {
          const laneY = H - 42
          for (const s of plan.shifts) {
            const x1 = xOf(s.start), x2 = xOf(s.end)
            const v = s.semitones
            ctx.fillStyle = v === 0 ? line : v < 0 ? 'rgba(110,168,255,.55)' : 'rgba(255,180,92,.55)'
            ctx.fillRect(x1 + 1, laneY, Math.max(1, x2 - x1 - 2), 13)
            if (x2 - x1 > 26) {
              ctx.fillStyle = label
              ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
              ctx.textAlign = 'center'
              ctx.textBaseline = 'middle'
              ctx.fillText(v > 0 ? `+${v}` : String(v), (x1 + x2) / 2, laneY + 7)
            }
          }
          ctx.fillStyle = dim
          ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
          ctx.textAlign = 'left'
          ctx.textBaseline = 'middle'
          ctx.fillText('变调', L, laneY + 7)
        }

        // 播放头
        if (playhead > 0) {
          const x = xOf(playhead)
          ctx.save()
          ctx.strokeStyle = error
          ctx.globalAlpha = 0.8
          ctx.lineWidth = 1
          ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, T + ph); ctx.stroke()
          ctx.restore()
        }

        // 左侧标签
        ctx.save()
        ctx.fillStyle = dim
        ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
        ctx.textAlign = 'left'
        ctx.textBaseline = 'top'
        ctx.fillText('Hz / 音名', 8, 6)
        ctx.restore()
      }, [analysis, plan, profile, size, tick, playhead, phrase])

      const timeAt = (clientX) => {
        const el = canvasRef.current
        if (!el || !analysis) return 0
        const rect = el.getBoundingClientRect()
        const L = 56, R = 16
        const pw = Math.max(1, rect.width - L - R)
        const x = Math.max(0, Math.min(pw, clientX - rect.left - L))
        return (x / pw) * analysis.duration
      }

      const onMove = (e) => {
        if (!analysis) return
        const t = timeAt(e.clientX)
        if (dragRef.current) onSeek(t)
        const i = Math.max(0, Math.min(analysis.f0.length - 1, Math.round(t * 100)))
        const f = analysis.f0[i]
        if (!(f > 0)) { setHover(null); return }
        const rect = canvasRef.current.getBoundingClientRect()
        const st = plan ? (() => {
          const s = (plan.shifts || []).find((x) => i >= x.from && i < x.to)
          return stateOfLocal(f, profile, s ? s.semitones : 0)
        })() : stateOfLocal(f, profile, 0)
        setHover({
          x: Math.max(0, Math.min(rect.width - 190, e.clientX - rect.left)),
          y: Math.max(30, e.clientY - rect.top),
          t, hz: f, st,
          shift: plan ? ((plan.shifts || []).find((x) => i >= x.from && i < x.to)?.semitones || 0) : 0,
        })
      }

      const stateOfLocal = (hz, prof, shift) => {
        const g = hz * Math.pow(2, (shift || 0) / 12)
        if (g >= prof.p5 && g <= prof.p95) return 0
        if (g >= prof.p1 && g <= prof.p99) return 1
        return 2
      }

      return h('div', { ref: wrapRef, className: 'ss-canvas-wrap' },
        h('canvas', {
          ref: canvasRef,
          className: 'ss-canvas',
          style: { height: `${size.h}px` },
          onMouseDown: (e) => { dragRef.current = true; onSeek(timeAt(e.clientX)) },
          onMouseUp: () => { dragRef.current = false },
          onMouseLeave: () => { dragRef.current = false; setHover(null) },
          onMouseMove: onMove,
        }),
        hover ? h('div', {
          className: 'ss-tooltip',
          style: { left: hover.x, top: hover.y },
        },
          `${fmtTime(hover.t)} · ${hover.hz.toFixed(1)}Hz · ${noteName(hover.hz)}`,
          hover.shift ? ` · ${hover.shift > 0 ? '+' : ''}${hover.shift}` : '',
          h('br'),
          hover.st === 0 ? '舒适区' : hover.st === 1 ? '舒适区外，极限区内' : '超出极限区',
        ) : null,
      )
    }

    // 自绘进度条：点任意位置直接跳转并播放，按住可拖动；不依赖原生 range 的行为。
    function SeekBar({ value, max, onSeek, disabled, label }) {
      const trackRef = useRef(null)
      const dragRef = useRef(null)
      const lastEmitRef = useRef(0)
      const [dragView, setDragView] = useState(null)
      const [hover, setHover] = useState(null)
      const total = Math.max(0, Number(max) || 0)
      const dragging = dragView != null
      const shown = Math.max(0, Math.min(total, dragging ? dragView : Number(value) || 0))
      const percent = total > 0 ? (shown / total) * 100 : 0

      const timeAt = (clientX) => {
        const el = trackRef.current
        if (!el) return 0
        const rect = el.getBoundingClientRect()
        if (!(rect.width > 0)) return 0
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
        return ratio * total
      }
      const emit = (t, force) => {
        const now = Date.now()
        if (!force && now - lastEmitRef.current < 90) return
        lastEmitRef.current = now
        onSeek(t)
      }
      // 拖动状态同时写进 ref：pointerdown 后的第一次 pointermove 可能早于重渲染。
      const setDrag = (t) => {
        dragRef.current = t
        setDragView(t)
      }
      const endDrag = (el, pointerId) => {
        dragRef.current = null
        setDragView(null)
        try { if (el && pointerId != null) el.releasePointerCapture(pointerId) } catch {}
      }

      return h('div', {
        ref: trackRef,
        className: 'ss-seek' + (dragging ? ' dragging' : '') + (disabled ? ' disabled' : ''),
        role: 'slider',
        tabIndex: disabled ? -1 : 0,
        'aria-label': label || '播放进度',
        'aria-valuemin': 0,
        'aria-valuemax': Math.round(total),
        'aria-valuenow': Math.round(shown),
        'aria-valuetext': `${fmtTime(shown)} / ${fmtTime(total)}`,
        onPointerDown: (e) => {
          if (disabled || e.button !== 0) return
          e.preventDefault()
          const t = timeAt(e.clientX)
          setDrag(t)
          try { e.currentTarget.focus({ preventScroll: true }) } catch {}
          try { e.currentTarget.setPointerCapture(e.pointerId) } catch {}
          emit(t, true)
        },
        onPointerMove: (e) => {
          if (disabled) return
          const t = timeAt(e.clientX)
          setHover(t)
          if (dragRef.current == null) return
          setDrag(t)
          emit(t, false)
        },
        onPointerUp: (e) => {
          if (disabled) return
          if (dragRef.current != null) {
            const t = timeAt(e.clientX)
            setDrag(t)
            emit(t, true)
          }
          endDrag(e.currentTarget, e.pointerId)
        },
        onPointerCancel: (e) => endDrag(e.currentTarget, e.pointerId),
        onPointerLeave: () => setHover(null),
        onKeyDown: (e) => {
          if (disabled) return
          const step = e.shiftKey ? 10 : 1
          let next = null
          if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = shown - step
          else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = shown + step
          else if (e.key === 'PageDown') next = shown - 10
          else if (e.key === 'PageUp') next = shown + 10
          else if (e.key === 'Home') next = 0
          else if (e.key === 'End') next = total
          if (next == null) return
          e.preventDefault()
          emit(Math.max(0, Math.min(total, next)), true)
        },
      },
        h('span', { className: 'ss-seek-rail' }),
        h('span', { className: 'ss-seek-fill', style: { width: `${percent}%` } }),
        h('span', { className: 'ss-seek-thumb', style: { left: `${percent}%` } }),
        hover != null && !dragging && total > 0
          ? h('span', { className: 'ss-seek-tip', style: { left: `${(hover / total) * 100}%` } }, fmtTime(hover))
          : null,
      )
    }

    class PageBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      render() {
        if (!this.state.error) return this.props.children
        return h('div', { className: 'ss-card ss-empty' },
          h('span', { className: 'ss-empty-icon' }, h(NavIcon, { d: ICON.alert, size: 22 })),
          h('h3', null, '这一页出错了'),
          h('p', null, String((this.state.error && this.state.error.message) || this.state.error)),
          h('div', { className: 'ss-empty-actions' },
            h('button', { className: 'ss-btn primary', onClick: () => this.props.onHome && this.props.onHome() }, '回到概览'),
            h('button', { className: 'ss-btn ghost', onClick: () => this.setState({ error: null }) }, '再试一次'),
          ),
        )
      }
    }

    function SettingsPanel({
      state, draft, setDraft, onSaved, toast,
      groups = SETTING_GROUPS, title = '插件设置', desc = '路径和参数；保存后会自动检查环境。', showChecks = true, inline = false,
    }) {
      const [saving, setSaving] = useState(false)
      if (!state) return h(Card, { title, icon: ICON.settings }, h('div', { className: 'ss-note' }, '正在读取设置…'))
      const s = state.settings
      const checks = s.checks || {}
      const d = draft || s
      const dirty = Boolean(draft) && JSON.stringify(draft) !== JSON.stringify(s)
      const set = (k, v) => setDraft({ ...d, [k]: v })
      const save = async () => {
        if (!dirty) return
        setSaving(true)
        const r = await post('/settings', d)
        setSaving(false)
        if (!r.ok) { toast(r.message || '保存失败', 'bad'); return }
        setDraft(null)
        toast('设置已保存，正在重新检查环境')
        onSaved()
      }
      const field = (spec) => {
        const { key, label } = spec
        const value = d[key]
        let input
        if (spec.select) {
          input = h('select', {
            className: 'ss-select',
            value: String(value ?? ''),
            onChange: (e) => {
              const raw = e.target.value
              const hit = spec.select.find(([v]) => String(v) === raw)
              set(key, hit ? hit[0] : raw)
            },
          }, spec.select.map(([v, text]) => h('option', { key: String(v), value: String(v) }, text)))
        } else if (spec.type === 'number') {
          input = h('input', {
            className: 'ss-input', type: 'number', step: spec.step || '1', value: value ?? '',
            onChange: (e) => set(key, Number(e.target.value)),
          })
        } else {
          const type = spec.type === 'password' ? 'password' : 'text'
          const placeholder = spec.key === 'neteaseCookie' && s.neteaseCookieSet
            ? '已保存（留空不改）'
            : spec.placeholder || ''
          input = h('input', {
            className: 'ss-input', type, value: value ?? '', placeholder,
            autoComplete: type === 'password' ? 'off' : undefined,
            onChange: (e) => set(key, e.target.value),
          })
        }
        if (spec.key === 'neteaseCookie' && s.neteaseCookieSet) {
          input = h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
            h('div', { style: { flex: 1, minWidth: 0 } }, input),
            h('button', {
              className: 'ss-btn sm ghost', type: 'button', title: '保存后清除已存 Cookie',
              onClick: () => set(key, ''),
            }, '清除'),
          )
        }
        return h('div', { key, className: 'ss-field' + (spec.wide ? ' wide' : '') },
          h('label', null, label),
          input,
        )
      }
      const checkTags = [
        ['python', checks.python, 'Python'],
        ['rvc', checks.rvc, 'RVC'],
        ['models', checks.models, '模型目录'],
        ['separator', checks.separator && checks.separatorModels, '分离器'],
        ['soulx', checks.soulx, 'SoulX'],
      ]
      return h(React.Fragment, null,
        h(Card, {
          title,
          icon: ICON.settings,
          desc,
          right: showChecks ? h('div', { className: 'ss-check' },
            checkTags.map(([id, ok, text]) => h('span', { key: id, className: 'ss-tag ' + (ok ? 'good' : 'warn') }, ok ? `${text} OK` : `${text} 缺失`)),
          ) : null,
          className: 'ss-settings',
        },
          h('div', { className: 'ss-settings-sections' },
            groups.map((g, i) => h(SettingsGroup, { key: g.id, group: g, defaultOpen: i < 2 || g.id === 'netease' },
              g.items.map((spec) => field(spec)),
            )),
          ),
        ),
        h('div', { className: 'ss-savebar' + (inline ? ' inline' : '') },
          h('div', { className: 'ss-savebar-text' + (dirty ? ' dirty' : '') }, dirty ? '有未保存的改动' : '设置已同步'),
          h('div', { className: 'ss-savebar-actions' },
            h('button', { className: 'ss-btn ghost', disabled: !dirty || saving, onClick: () => setDraft(null) }, '撤销'),
            h('button', { className: 'ss-btn primary', disabled: !dirty || saving, onClick: save }, saving ? '保存中…' : '保存设置'),
          ),
        ),
      )
    }

    function StudioPage() {
      const [state, setState] = useState(null)
      // 上次离开时的内容（歌曲 / 分析 id / 方案 / 音色 / 后端 / 未保存的设置草稿）。
      const [initialWorkspace] = useState(readWorkspace)
      const initialSavedPage = useRef(readSavedPage())
      const [page, setPage] = useState(initialSavedPage.current.page)
      const [studioView, setStudioView] = useState(initialSavedPage.current.view || initialWorkspace?.studioView || 'songs')
      const pageRef = useRef(page)
      const pageElRef = useRef(null)
      const restoredPlans = initialWorkspace
        && initialWorkspace.plans
        && initialWorkspace.plans.data
        && initialWorkspace.plans.analysisId === (initialWorkspace.analysisId || '')
        && Array.isArray(initialWorkspace.plans.data.table)
        ? initialWorkspace.plans.data
        : null
      const restoredSelectedId = (() => {
        if (!restoredPlans) return ''
        const wanted = initialWorkspace.selectedId || restoredPlans.selectedId || ''
        return restoredPlans.table.some((row) => row.id === wanted) ? wanted : (restoredPlans.selectedId || '')
      })()
      const [songId, setSongId] = useState(() => initialWorkspace?.songId || '')
      const [voiceId, setVoiceId] = useState(() => initialWorkspace?.voiceId || '')
      const [analysis, setAnalysis] = useState(null)
      const [analysisId, setAnalysisId] = useState(() => initialWorkspace?.analysisId || '')
      const [plans, setPlans] = useState(restoredPlans)
      const [selectedId, setSelectedId] = useState(restoredSelectedId)
      const [job, setJob] = useState(null)
      const [audioUrl, setAudioUrl] = useState('')
      // 当前分析已经缓存的翻唱成品（每个八度方案一份），点「翻唱」可以切换播放。
      const [renders, setRenders] = useState([])
      const [renderId, setRenderId] = useState('')
      const [audioSource, setAudioSource] = useState('original')
      // 翻唱音源：默认 mix.mp3（体积小）；加载失败才退到 mix.wav。
      const [coverUseMix, setCoverUseMix] = useState(true)
      // 音频管线卡住时换一个全新的 <audio>（用户说的“清除音频”），比 reload 更彻底。
      const [audioEpoch, setAudioEpoch] = useState(0)
      // 某些环境（桌面端 dsh-app:// 协议）会把音频当成不可跳转的流；这种情况改用 Blob 播放。
      const [blobSrcs, setBlobSrcs] = useState({})
      // 当前 <audio> 的真实时长（进度条按它显示，避免和分析时长不一致时跳不过去）。
      const [mediaDuration, setMediaDuration] = useState(0)
      const [audioNote, setAudioNote] = useState('')
      const [activePhrase, setActivePhrase] = useState(-1)
      const [playhead, setPlayhead] = useState(0)
      const [isPlaying, setIsPlaying] = useState(false)
      const [toast, setToast] = useState(null)
      const [uploading, setUploading] = useState(false)
      const [backend, setBackend] = useState(() => (initialWorkspace?.backend === 'soulx' ? 'soulx' : 'rvc'))
      const [settingsDraft, setSettingsDraft] = useState(() => {
        const draft = initialWorkspace?.settingsDraft
        return draft && typeof draft === 'object' && !Array.isArray(draft) ? draft : null
      })
      const [searchQuery, setSearchQuery] = useState(() => initialWorkspace?.searchQuery || '')
      const [searchResults, setSearchResults] = useState(() =>
        (Array.isArray(initialWorkspace?.searchResults) ? initialWorkspace.searchResults : null))
      const [searching, setSearching] = useState(false)
      const [importingId, setImportingId] = useState('')
      const [searchMsg, setSearchMsg] = useState('')
      // 训练页：表单、目录检查结果、最近一次训练结果。
      const [trainForm, setTrainForm] = useState(() => trainFormOf(initialWorkspace?.trainForm))
      const [trainCheck, setTrainCheck] = useState(null)
      const [trainChecking, setTrainChecking] = useState(false)
      const [trainResult, setTrainResult] = useState(() => initialWorkspace?.trainResult || null)
      const [trainMsg, setTrainMsg] = useState('')
      // 制作台：歌曲库、生成队列。
      const [library, setLibrary] = useState([])
      const [libraryLoading, setLibraryLoading] = useState(false)
      const [renderJobs, setRenderJobs] = useState([])
      const [envManifest, setEnvManifest] = useState(null)
      const [envManifestLoading, setEnvManifestLoading] = useState(false)
      const [envManifestError, setEnvManifestError] = useState('')
      // 手动下载默认收起；一键安装失败时自动展开并高亮失败项。
      const [envManualOpen, setEnvManualOpen] = useState(false)
      // 正在写入的手动文件：{ id, pct }。
      const [envUpload, setEnvUpload] = useState(null)
      const envManualRef = useRef(null)
      // 两个后端各自的预加载状态：{ backend, status: 'loading'|'cancelling'|'done'|'cancelled'|'error', progress, message? }
      const [warmups, setWarmups] = useState({ rvc: null, soulx: null })
      // 正在卸载的后端：{ rvc?: boolean, soulx?: boolean }。
      const [unloading, setUnloading] = useState({})
      const warmupCancelRef = useRef(false)
      const warmupLockRef = useRef(false)
      // 恢复播放位置时用它触发一次“定位但不自动播放”。
      const [restoreToken, setRestoreToken] = useState(0)
      const restorePlayheadRef = useRef(null)
      const fileRef = useRef(null)
      const audioRef = useRef(null)
      const analysisIdRef = useRef('')
      // 最新播放位置：延迟回调（Blob 升级 / 版本回退）里不能读渲染时捕获的旧 playhead。
      const playheadRef = useRef(0)
      const stopAtRef = useRef(null)
      // 待执行的跳转：媒体还没拿到 metadata 时先记下来，等 loadedmetadata / canplay 再落地。
      const pendingSeekRef = useRef(null)
      // 刚做过程序化跳转时，忽略“旧位置”的 timeupdate，避免跳转被覆盖、乐句尾停提前触发。
      const seekGuardRef = useRef(null)
      // 当前 <audio> 已经加载的地址，用来判断换源后是否需要 load()。
      const loadedSrcRef = useRef('')
      // 已经尝试过回退的翻唱地址，避免反复切换。
      const coverFallbackRef = useRef('')
      // 已经上报过媒体状态的地址，避免重复写日志。
      const coverLoggedRef = useRef('')
      // 这次跳转之后应该处于播放状态；用来发现“seek 后变暂停、再也不播”的情况。
      const wantPlayRef = useRef(false)
      // Blob 缓存：原始地址 -> object URL；正在下载的地址。
      const blobSrcsRef = useRef({})
      const blobPendingRef = useRef(new Map())
      blobSrcsRef.current = blobSrcs
      // 卡顿看门狗：长时间 waiting 不动就重建 <audio>（同一个音源最多两次，60 秒后重新计数）。
      const stallTimerRef = useRef(null)
      const stallForRef = useRef({ src: '', count: 0, at: 0 })
      // 跳转后的校验定时器。
      const seekVerifyRef = useRef(null)
      const phrasePinnedRef = useRef(false)
      const toastTimer = useRef(null)
      const autoWarmed = useRef(false)

      // 每次渲染都刷新快照，卸载时（切面板）和定时器里直接写 localStorage。
      const hydratedRef = useRef(false)
      const workspaceSnapshotRef = useRef({})
      workspaceSnapshotRef.current = {
        v: 1,
        songId,
        voiceId,
        backend,
        analysisId,
        selectedId,
        renderId,
        audioUrl,
        audioSource,
        plans: plans ? { analysisId, data: plans } : null,
        settingsDraft,
        searchQuery,
        searchResults,
        trainForm,
        trainResult,
        studioView,
        jobId: job && (job.status === 'queued' || job.status === 'running') ? job.id : '',
        playhead: Number(playhead) || 0,
      }
      const flushWorkspace = useCallback(() => {
        // 恢复完成前不写，避免把快照里还没接回来的成品 / 播放位置覆盖成空值。
        if (!hydratedRef.current) return
        saveWorkspace(workspaceSnapshotRef.current)
      }, [])

      // 状态一变就存；播放位置靠定时器和卸载时补存。
      useEffect(() => { flushWorkspace() }, [
        flushWorkspace, songId, voiceId, backend, analysisId, selectedId, renderId,
        audioUrl, audioSource, plans, settingsDraft, searchQuery, searchResults,
        trainForm, trainResult, studioView, job?.id, job?.status,
      ])
      useEffect(() => {
        const timer = setInterval(flushWorkspace, 3000)
        const onHide = () => flushWorkspace()
        window.addEventListener('pagehide', onHide)
        return () => {
          clearInterval(timer)
          window.removeEventListener('pagehide', onHide)
          flushWorkspace()
        }
      }, [flushWorkspace])

      const go = useCallback((id) => {
        if (!PAGE_IDS.has(id)) return
        pageRef.current = id
        setPage(id)
        try { localStorage.setItem(PAGE_KEY, id) } catch {}
      }, [])

      const goStudio = useCallback((view) => {
        if (view) setStudioView(view)
        go('studio')
      }, [go])

      const notify = useCallback((text, kind = '') => {
        setToast({ text, kind })
        if (toastTimer.current) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToast(null), 3200)
      }, [])

      // 排队生成完成时除了应用内提示，浏览器允许的话再发一条系统通知。
      const copyText = useCallback(async (text, label = '内容') => {
        const value = String(text == null ? '' : text)
        if (!value) return
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(value)
          else throw new Error('no clipboard')
        } catch {
          try {
            const ta = document.createElement('textarea')
            ta.value = value
            ta.style.position = 'fixed'
            ta.style.opacity = '0'
            document.body.appendChild(ta)
            ta.select()
            document.execCommand('copy')
            ta.remove()
          } catch { notify('复制失败，请手动选择文本', 'bad'); return }
        }
        notify(`${label}已复制`)
      }, [notify])

      const notifyDone = useCallback((text) => {
        notify(text, 'good')
        try {
          if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            new Notification('唱歌工作室', { body: text })
          }
        } catch {}
      }, [notify])

      const loadRenders = useCallback(async (id) => {
        if (!id) { setRenders([]); return [] }
        const r = await get(`/renders?analysisId=${id}`)
        const list = r.ok ? (r.renders || []) : []
        // 请求回来时可能已经切到别的分析（比如恢复期间后台任务完成）：旧列表不能覆盖新状态。
        if (analysisIdRef.current !== id) return list
        setRenders(list)
        return list
      }, [])

      const loadLibrary = useCallback(async () => {
        setLibraryLoading(true)
        const r = await get('/library')
        setLibraryLoading(false)
        if (r.ok) setLibrary(r.songs || [])
        return r
      }, [])

      const loadManifest = useCallback(async () => {
        setEnvManifestLoading(true)
        const r = await get('/env/manifest')
        setEnvManifestLoading(false)
        setEnvManifest(r.ok ? (r.entries || []) : [])
        setEnvManifestError(r.ok ? '' : (r.message || '下载清单读取失败，重启 DSH 后再试'))
        return r
      }, [])

      const loadState = useCallback(async () => {
        const r = await get('/state')
        if (!r.ok) { notify(r.message || '读取插件状态失败', 'bad'); return }
        setState(r)
        setSongId((cur) => cur || r.songs?.[0]?.id || '')
        setVoiceId((cur) => cur || r.voices?.find((v) => v.calibrated)?.id || '')
      }, [notify])

      useEffect(() => { loadState() }, [loadState])

      // 首次进入 / 环境未就绪时，先把用户带到「环境安装」。
      const envRedirectedRef = useRef(false)
      useEffect(() => {
        if (!state || envRedirectedRef.current) return
        envRedirectedRef.current = true
        if (!state.deps?.ready && pageRef.current !== 'env') go('env')
      }, [state, go])

      useEffect(() => { loadLibrary() }, [loadLibrary])
      useEffect(() => { if (page === 'env') loadManifest() }, [page, loadManifest])

      // 生成队列：轮询全部任务，任何一个翻唱完成都提醒并刷新歌曲库。
      const seenRenderJobsRef = useRef(null)
      useEffect(() => {
        let alive = true
        const tick = async () => {
          const r = await get('/jobs')
          if (!alive || !r.ok) return
          const renders = (r.jobs || []).filter((j) => j.type === 'render')
          setRenderJobs(renders)
          const done = renders.filter((j) => j.status === 'done' && j.result)
          if (!seenRenderJobsRef.current) {
            seenRenderJobsRef.current = new Set(done.map((j) => j.id))
            return
          }
          let changed = false
          for (const j of done) {
            if (seenRenderJobsRef.current.has(j.id)) continue
            seenRenderJobsRef.current.add(j.id)
            changed = true
            notifyDone(`《${j.meta?.songName || '歌曲'}》翻唱完成`)
            if (j.meta?.analysisId && j.meta.analysisId === analysisIdRef.current) {
              await loadRenders(j.meta.analysisId)
            }
          }
          if (changed) loadLibrary()
        }
        tick()
        const timer = setInterval(tick, 1500)
        return () => { alive = false; clearInterval(timer) }
      }, [loadLibrary, loadRenders, notifyDone])

      // 面板切回来：按快照里的 id 把分析结果和已缓存成品接回来。
      // 分析/成品都是 Host 上的文件，重取即可，不重新跑模型。
      useEffect(() => {
        const ws = initialWorkspace
        if (!ws) { hydratedRef.current = true; return undefined }
        let alive = true
        ;(async () => {
          try {
            if (ws.analysisId) {
              const r = await get(`/analysis/${ws.analysisId}`)
              if (!alive) return
              // 恢复期间后台任务已切到新的分析：以新结果为准，不要用旧快照覆盖。
              if (analysisIdRef.current !== ws.analysisId) return
              if (!r.ok) {
                // 分析文件已经不在了：清掉指向它的状态，避免切回来是一个空壳。
                setAnalysisId('')
                setAnalysis(null)
                setPlans(null)
                setSelectedId('')
                setRenderId('')
                setAudioUrl('')
                setAudioSource('original')
                return
              }
              setAnalysis(r.analysis)
            }
            let list = []
            if (ws.analysisId) list = await loadRenders(ws.analysisId)
            if (!alive) return
            if (analysisIdRef.current !== ws.analysisId) return
            const hit = (ws.renderId && list.find((x) => x.id === ws.renderId))
              || (ws.audioUrl && list.find((x) => x.audioUrl === ws.audioUrl))
              || null
            if (hit) {
              setRenderId(hit.id)
              setAudioUrl(hit.audioUrl)
              if (ws.audioSource === 'cover') setAudioSource('cover')
            }
            const at = Number(ws.playhead)
            if (at > 0) {
              restorePlayheadRef.current = at
              setRestoreToken((n) => n + 1)
            }
          } finally {
            if (alive) {
              hydratedRef.current = true
              // 恢复完成立即落盘一次：期间后台任务可能已经写入了新结果。
              flushWorkspace()
            }
          }
        })()
        return () => { alive = false }
      }, [])

      useEffect(() => {
        const el = pageElRef.current
        if (el) el.scrollTop = 0
      }, [page])

      // 试听条只在制作台显示：离开制作台时暂停播放（保留进度），避免在其他页面还在响。
      useEffect(() => {
        if (page === 'studio') return
        wantPlayRef.current = false
        pendingSeekRef.current = null
        try { audioRef.current?.pause() } catch {}
        setIsPlaying(false)
      }, [page])

      useEffect(() => {
        setActivePhrase(-1)
        phrasePinnedRef.current = false
        stopAtRef.current = null
        pendingSeekRef.current = null
        seekGuardRef.current = null
        loadedSrcRef.current = ''
        if (seekVerifyRef.current) { clearTimeout(seekVerifyRef.current); seekVerifyRef.current = null }
        coverFallbackRef.current = ''
        setCoverUseMix(true)
        setMediaDuration(0)
        setAudioNote('')
        setAudioEpoch(0)
        try { Object.values(blobSrcsRef.current).forEach((u) => URL.revokeObjectURL(u)) } catch {}
        blobSrcsRef.current = {}
        setBlobSrcs({})
        setPlayhead(0)
        setAudioSource('original')
        setIsPlaying(false)
        setRenders([])
        setRenderId('')
        loadRenders(analysisId)
        try {
          audioRef.current?.pause()
          if (audioRef.current) audioRef.current.currentTime = 0
        } catch {}
      }, [analysisId, loadRenders])

      useEffect(() => {
        setCoverUseMix(true)
        coverFallbackRef.current = ''
      }, [audioUrl])

      useEffect(() => {
        if (audioUrl) return
        if (audioSource === 'cover') {
          pendingSeekRef.current = null
          seekGuardRef.current = null
          coverFallbackRef.current = ''
          setCoverUseMix(true)
          setMediaDuration(0)
          setAudioNote('')
            setIsPlaying(false)
          try { audioRef.current?.pause() } catch {}
          setAudioSource('original')
        }
      }, [audioUrl])

      // 换源（原曲 / 翻唱）后主动重新加载，并把之前记下的跳转交给新音源。
      useLayoutEffect(() => {
        const el = audioRef.current
        if (!el) return
        const src = el.getAttribute('src') || ''
        if (!src) return
        if (loadedSrcRef.current === src) return
        loadedSrcRef.current = src
        clearStallWatch()
        setMediaDuration(0)
        const intent = pendingSeekRef.current
        try { el.load() } catch {}
        if (intent && intent.play !== false) {
          // 新资源要重新取 metadata；真正跳转在 loadedmetadata / canplay 里执行。
          try {
            const p = el.play()
            if (p && p.catch) p.catch(() => {})
          } catch {}
        }
      }, [audioSource, audioUrl, analysis, audioEpoch, blobSrcs])

      useEffect(() => () => {
        if (toastTimer.current) clearTimeout(toastTimer.current)
        if (seekVerifyRef.current) clearTimeout(seekVerifyRef.current)
        if (stallTimerRef.current) clearTimeout(stallTimerRef.current)
        try { Object.values(blobSrcsRef.current).forEach((u) => URL.revokeObjectURL(u)) } catch {}
      }, [])

      const jobBusy = Boolean(job && (job.status === 'queued' || job.status === 'running'))
      const soulxReady = Boolean(state?.settings?.checks?.soulx)
      const envReady = Boolean(state?.deps?.ready)
      const deps = state?.deps || { items: [], missing: [] }
      const setupBusy = Boolean(job && job.type === 'setup' && (job.status === 'queued' || job.status === 'running'))
      const setupFailed = Boolean(job && job.type === 'setup' && job.status === 'error')
      // 一键安装失败时把「手动下载」展开并滚过去；失败项由错误信息里的 URL / 名称匹配。
      useEffect(() => {
        if (!setupFailed) return
        setEnvManualOpen(true)
        const timer = setTimeout(() => {
          try { envManualRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }) } catch {}
        }, 150)
        return () => clearTimeout(timer)
      }, [setupFailed, job?.id])

      // 预加载没有真实进度事件：这里让进度环平滑逼近 90%，成功后再跳到 100%。
      const warmupBusy = Boolean(
        (warmups.rvc && (warmups.rvc.status === 'loading' || warmups.rvc.status === 'cancelling'))
        || (warmups.soulx && (warmups.soulx.status === 'loading' || warmups.soulx.status === 'cancelling')),
      )
      useEffect(() => {
        if (!warmupBusy) return undefined
        const timer = setInterval(() => {
          setWarmups((cur) => {
            let changed = false
            const next = { ...cur }
            for (const key of ['rvc', 'soulx']) {
              const item = cur[key]
              if (!item || item.status !== 'loading') continue
              const remain = 0.9 - (item.progress || 0)
              if (remain <= 0.004) continue
              next[key] = { ...item, progress: Math.min(0.9, (item.progress || 0) + remain * 0.12) }
              changed = true
            }
            return changed ? next : cur
          })
        }, 400)
        return () => clearInterval(timer)
      }, [warmupBusy])
      const song = state?.songs?.find((s) => s.id === songId)
      const voice = state?.voices?.find((v) => v.id === voiceId)
      const promptReady = Boolean(voice?.profile?.promptWav)
      const profile = analysis?.profile || voice?.profile || null
      const selected = plans?.table?.find((r) => r.id === selectedId) || plans?.selected || null
      const songs = state?.songs || []
      const voices = state?.voices || []
      const originalUrl = analysis?.songId ? `${API}/audio?kind=source&id=${analysis.songId}` : ''
      const coverMixUrl = audioUrl || ''
      const coverWavUrl = coverMixUrl ? coverMixUrl.replace('kind=mix', 'kind=wav') : ''
      const coverVariant = coverUseMix ? 'mix' : 'wav'
      const coverUrl = coverMixUrl ? (coverUseMix ? coverMixUrl : coverWavUrl) : ''
      const rawPlayableUrl = audioSource === 'cover' && coverUrl ? coverUrl : originalUrl
      // 不可跳转的传输层会升级成 Blob URL：整段音频在内存里，seek 一定生效。
      const playableUrl = blobSrcs[rawPlayableUrl] || rawPlayableUrl
      const totalDuration = Math.max(0, Number(mediaDuration) || Number(analysis?.duration) || 0)
      const phrases = analysis?.phrases || []
      const activePhraseObj = activePhrase >= 0 ? phrases[activePhrase] || null : null
      analysisIdRef.current = analysisId
      playheadRef.current = Number(playhead) || 0

      // 方案行 <-> 已缓存成品：同一音色 + 后端 + 层级 + 完全相同的变调表。
      const samePlan = (row, render) => {
        if (!row || !render) return false
        if (render.voiceId && voiceId && render.voiceId !== voiceId) return false
        if (render.backend && render.backend !== backend) return false
        if ((render.level || '') !== (row.level || '')) return false
        return JSON.stringify(render.shifts || []) === JSON.stringify(row.shifts || [])
      }
      const renderForRow = (row, list) => (list || renders || []).find((x) => samePlan(row, x)) || null
      const renderBase = (render) => {
        const row = (plans?.table || []).find((x) => samePlan(x, render))
        const level = render.level || ''
        return row?.label
          || (level === 'global' ? '全局八度' : level === 'section' ? '分段八度' : level === 'phrase' ? '乐句八度' : level === 'none' ? '原曲 0' : '方案')
      }
      // 播放条标题：方案 · 后端；下拉选项：方案 · 生成时间（同一方案多次生成时用来区分）。
      const renderLabel = (render, withStamp) => {
        if (!render) return '翻唱'
        const base = renderBase(render)
        const stamp = withStamp ? fmtStamp(render.createdAt) : ''
        if (withStamp) return stamp ? `${base} · ${stamp}` : base
        return `${base} · ${render.backend === 'soulx' ? 'SoulX' : 'RVC'}`
      }
      const selectedRender = renders.find((x) => x.id === renderId) || null
      // 时间轴 / 音色区间要跟着当前试听的版本走：翻唱时用该成品的方案与音色。
      const renderPlanRow = selectedRender ? (plans?.table || []).find((row) => samePlan(row, selectedRender)) || null : null
      const renderPlan = selectedRender
        ? (renderPlanRow || {
          id: `render-${selectedRender.id}`,
          label: (() => {
            const level = selectedRender.level || ''
            return level === 'global' ? '全局八度' : level === 'section' ? '分段八度' : level === 'phrase' ? '乐句八度' : level === 'none' ? '原曲 0' : '已缓存版本'
          })(),
          level: selectedRender.level || '',
          shifts: selectedRender.shifts || [],
          coverage: selectedRender.coverage || null,
          changes: selectedRender.changes,
          unresolved: [],
        })
        : null
      const onCover = audioSource === 'cover' && Boolean(selectedRender)
      const activePlan = onCover && renderPlan ? renderPlan : selected
      const renderVoice = selectedRender && selectedRender.voiceId
        ? (voices.find((x) => x.id === selectedRender.voiceId) || null)
        : null
      // 换音色生成过的成品，音域带也要换成那个音色的 profile。
      const rangeProfile = onCover && renderVoice?.profile ? renderVoice.profile : profile
      // 按当前音域档重新算覆盖率（加权，和方案页一致），保证切换版本后数字对得上。
      const coverageFor = (planObj, prof) => {
        if (!analysis || !prof || !analysis.f0) return null
        const f0 = analysis.f0
        const rms = analysis.rms || []
        const shifts = (planObj && planObj.shifts) || []
        let si = 0
        let num = 0
        let den = 0
        for (let i = 0; i < f0.length; i++) {
          while (si < shifts.length && i >= (shifts[si].to | 0)) si++
          const semis = si < shifts.length && i >= (shifts[si].from | 0) ? (shifts[si].semitones | 0) : 0
          const f = f0[i]
          if (!(f > 0)) continue
          const w = Math.max(rms[i] || 0, 1e-6)
          den += w
          const g = f * Math.pow(2, semis / 12)
          if (g >= prof.p5 && g <= prof.p95) num += w
        }
        return den > 0 ? num / den : null
      }

      // 选一个已缓存的成品来试听（切换音源并播放）。
      const selectRender = (render, opts) => {
        if (!render) return
        const at = opts && opts.at != null ? Number(opts.at) : Math.max(0, Number(playhead) || 0)
        const same = render.audioUrl === coverMixUrl
        setRenderId(render.id)
        setAudioUrl(render.audioUrl)
        setCoverUseMix(true)
        coverFallbackRef.current = ''
        const row = (plans?.table || []).find((x) => samePlan(x, render))
        if (row) setSelectedId(row.id)
        if (audioSource === 'cover' && same) { playFrom(at); return }
        pendingSeekRef.current = { time: at, stopAt: null, play: true }
        loadedSrcRef.current = ''
        setPlayhead(at)
        setAudioSource('cover')
      }

      // 选中方案行时，如果这一版已经缓存过，直接把它挂到「翻唱」上。
      const pickPlan = (rowId) => {
        setSelectedId(rowId)
        const row = (plans?.table || []).find((r) => r.id === rowId) || null
        const hit = renderForRow(row)
        if (hit) {
          setRenderId(hit.id)
          setAudioUrl(hit.audioUrl)
        }
      }

      const onJobDone = useCallback(async (j) => {
        if (j.type === 'setup') {
          notify(j.result?.ready ? '环境准备完成' : '环境仍有缺失项')
          await loadState()
          loadManifest()
          return
        }
        if (j.type === 'analyze') {
          const id = j.result?.analysisId
          if (!id) { notify('分析完成但没有结果', 'bad'); return }
          const r = await get(`/analysis/${id}`)
          if (!r.ok) { notify(r.message || '读取分析失败', 'bad'); return }
          setAnalysis(r.analysis)
          setAnalysisId(id)
          setPlans(null)
          setSelectedId('')
          setAudioUrl('')
          setPlayhead(0)
          setJob(null)
          notify('分析完成，去时间轴看看')
          loadLibrary()
          if (pageRef.current === 'studio') goStudio('timeline')
          loadState()
        } else if (j.type === 'render') {
          if (j.result?.audioUrl) {
            setAudioUrl(j.result.audioUrl)
            const list = await loadRenders(analysisIdRef.current)
            const hit = list.find((x) => x.audioUrl === j.result.audioUrl)
            setRenderId(hit ? hit.id : '')
            notify('生成完成，播放条可切到翻唱')
            if (pageRef.current === 'studio' && studioView === 'timeline') goStudio('timeline')
          }
          loadState()
        } else if (j.type === 'train') {
          const result = j.result || null
          if (result) {
            setTrainResult(result)
            if (result.voiceId && result.profilePath) setVoiceId(result.voiceId)
          }
          notify(result?.voiceId ? `训练完成：${result.label || result.voiceId}` : '训练完成')
          await loadState()
          go('train')
        }
      }, [notify, loadState, go, loadRenders])

      // 切走时还在跑的任务：回来接着显示进度；已经跑完的把结果接上，
      // 不用因为切了一下面板就重新点一遍。
      useEffect(() => {
        const ws = initialWorkspace
        if (!ws || !ws.jobId) return undefined
        let alive = true
        get(`/jobs/${ws.jobId}`).then((r) => {
          if (!alive || !r.ok) return
          const j = r.job
          if (j.status === 'queued' || j.status === 'running') setJob(j)
          else if (j.status === 'done') onJobDone(j)
          else if (j.status === 'error') {
            setJob(j)
            notify(j.error || '任务失败', 'bad')
          }
        }).catch(() => {})
        return () => { alive = false }
      }, [])

      useEffect(() => {
        if (!job || (job.status !== 'queued' && job.status !== 'running')) return undefined
        let stopped = false
        const tick = async () => {
          const r = await get(`/jobs/${job.id}`)
          if (stopped || !r.ok) return
          setJob(r.job)
          if (r.job.status === 'done') onJobDone(r.job)
          else if (r.job.status === 'error') notify(r.job.error || '任务失败', 'bad')
        }
        tick()
        const timer = setInterval(tick, 700)
        return () => { stopped = true; clearInterval(timer) }
      }, [job?.id, job?.status, onJobDone, notify])

      // 从歌曲库选一首歌：换歌时清掉上一首的分析 / 方案 / 成品引用。
      const pickSong = (id) => {
        // 同一个音色分析过的歌直接复用分析结果；没翻唱 / 换音色的才需要重新分析 F0。
        const entry = library.find((s) => s.id === id) || null
        const hit = entry?.analyses?.find((a) => a.voiceId === voiceId) || null
        if (id !== songId) {
          setAnalysis(null)
          setAnalysisId(hit ? hit.id : '')
          setPlans(null)
          setSelectedId('')
          setAudioUrl('')
          setRenderId('')
          setPlayhead(0)
          setActivePhrase(-1)
        } else if (!analysisId && hit) {
          setAnalysisId(hit.id)
        }
        setSongId(id)
        goStudio('songs')
      }

      const upload = async (file) => {
        if (!file) return
        setUploading(true)
        try {
          const r = await fetch(`${API}/songs?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file }).then((x) => x.json())
          if (!r.ok) { notify(r.message || '上传失败', 'bad'); return }
          setSongId(r.song.id)
          setAnalysis(null)
          setAnalysisId('')
          setPlans(null)
          setAudioUrl('')
          notify(`已上传：${r.song.name}`)
          goStudio('songs')
          loadState()
          loadLibrary()
        } catch (e) {
          notify('上传失败：' + e.message, 'bad')
        } finally {
          setUploading(false)
        }
      }

      const analyze = async () => {
        if (!envReady) { notify('环境未准备：请先在「环境」页完成依赖检查/下载', 'bad'); go('env'); return }
        if (!songId || !voiceId) { notify('先选歌曲和音色模型', 'bad'); goStudio('songs'); return }
        setAnalysis(null)
        setPlans(null)
        setAudioUrl('')
        const r = await post('/analyze', { songId, voiceId })
        if (!r.ok) { notify(r.message || '分析失败', 'bad'); return }
        if (r.cached && r.analysisId) {
          const a = await get(`/analysis/${r.analysisId}`)
          if (a.ok) {
            setAnalysis(a.analysis)
            setAnalysisId(r.analysisId)
            setPlans(null)
            setJob(null)
            notify('使用缓存的分析结果')
            loadLibrary()
            goStudio('timeline')
          } else notify(a.message || '读取分析失败', 'bad')
          return
        }
        setJob(r.job)
        goStudio('songs')
      }

      const plan = async () => {
        if (!envReady) { notify('环境未准备：请先在「环境」页完成依赖检查/下载', 'bad'); go('env'); return }
        if (!analysisId) { notify('先分析 F0', 'bad'); goStudio('songs'); return }
        const r = await post('/plan', { analysisId, voiceId })
        if (!r.ok) { notify(r.message || '规划失败', 'bad'); return }
        setPlans(r)
        setSelectedId(r.selectedId)
        const hit = renderForRow(r.selected, renders)
        setRenderId(hit ? hit.id : '')
        setAudioUrl(hit ? hit.audioUrl : '')
        if (hit) notify(`方案：${r.selected?.label || r.selectedId} · 已缓存成品`)
        else notify(`方案：${r.selected?.label || r.selectedId}`)
        goStudio('plans')
      }

      const mergeRenderJob = useCallback((next) => {
        setRenderJobs((prev) => {
          const map = new Map(prev.map((j) => [j.id, j]))
          map.set(next.id, next)
          return [...map.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        })
      }, [])

      const render = async () => {
        if (!envReady) { notify('环境未准备：请先在「环境」页完成依赖检查/下载', 'bad'); go('env'); return }
        if (!analysisId || !selected) { notify('先生成方案', 'bad'); goStudio('plans'); return }
        try {
          if (typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission()
        } catch {}
        const r = await post('/render', { analysisId, voiceId, backend, plan: selected })
        if (!r.ok) { notify(r.message || '生成失败', 'bad'); return }
        if (r.cached && r.audioUrl) {
          setAudioUrl(r.audioUrl)
          const list = await loadRenders(analysisId)
          const hit = list.find((x) => x.audioUrl === r.audioUrl)
          setRenderId(hit ? hit.id : '')
          notify('已使用本地成品缓存')
          loadLibrary()
          goStudio('timeline')
          return
        }
        if (r.reused && r.job) {
          mergeRenderJob(r.job)
          notify('相同方案正在生成，已显示在队列里')
          goStudio('songs')
          return
        }
        if (!r.job) { notify('没有拿到生成任务', 'bad'); return }
        mergeRenderJob(r.job)
        notify('已加入生成队列')
        goStudio('songs')
      }

      const cancel = async () => {
        if (!job) return
        await post(`/cancel/${job.id}`)
      }

      const cancelRenderJob = async (id) => {
        await post(`/cancel/${id}`)
        setRenderJobs((prev) => prev.map((j) => (j.id === id ? { ...j, status: 'cancelled', stage: '已取消' } : j)))
      }

      const checkEnv = async () => {
        const r = await get('/deps?refresh=1')
        if (!r.ok) { notify(r.message || '检查失败', 'bad'); return }
        notify(r.ready ? '环境已就绪' : `还缺 ${r.missing?.length || 0} 项`)
        loadState()
        loadManifest()
      }

      /**
       * 把用户已下载好的文件写进清单里的目标路径。
       * 用 XHR 而不是 fetch：需要上传进度，2.6 GB 的模型要能看见百分比。
       */
      const uploadEnvFile = (entry, file) => {
        if (!entry || !file || entry.present) return
        setEnvUpload({ id: entry.id, pct: 0 })
        const xhr = new XMLHttpRequest()
        xhr.open('POST', `${API}/env/file?id=${encodeURIComponent(entry.id)}&name=${encodeURIComponent(file.name)}`)
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setEnvUpload({ id: entry.id, pct: e.loaded / e.total })
        }
        xhr.onerror = () => { setEnvUpload(null); notify('写入失败：和插件后端的连接中断', 'bad') }
        xhr.onabort = () => setEnvUpload(null)
        xhr.onload = () => {
          setEnvUpload(null)
          let r = null
          try { r = JSON.parse(xhr.responseText) } catch {}
          if (!r || !r.ok) { notify((r && r.message) || `写入失败（HTTP ${xhr.status}）`, 'bad'); return }
          notify(`${entry.label} 已放进目标位置`)
          loadManifest()
          loadState()
        }
        xhr.send(file)
      }

      const startSetup = async () => {
        const r = await post('/setup')
        if (!r.ok) { notify(r.message || '无法开始准备', 'bad'); return }
        setJob(r.job)
      }

      const patchTrain = (patch) => setTrainForm((form) => ({ ...form, ...patch }))

      const checkDataset = async (explicit = false) => {
        const value = String(trainForm.datasetPath || '').trim()
        if (!value) {
          setTrainCheck(null)
          if (explicit) notify('先填训练数据目录', 'bad')
          return
        }
        setTrainChecking(true)
        const r = await get(`/train/check?path=${encodeURIComponent(value)}`)
        setTrainChecking(false)
        setTrainCheck(r)
        if (r.ok && !String(trainForm.name || '').trim()) {
          const folder = String(r.path || '').split(/[\\/]/).filter(Boolean).pop() || ''
          const guess = folder.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^[^A-Za-z0-9]+/, '').slice(0, 40)
          if (guess) patchTrain({ name: guess })
        }
        if (explicit) {
          if (r.ok) notify(`找到 ${r.files} 个音频文件`)
          else notify(r.message || '目录不可用', 'bad')
        }
      }

      const startTraining = async () => {
        const form = trainForm
        if (!state?.training?.ok) {
          notify('训练环境还没准备好，先去「环境」页一键准备', 'bad')
          go('env')
          return
        }
        if (!String(form.datasetPath || '').trim()) { notify('先填训练数据目录', 'bad'); return }
        if (!String(form.name || '').trim()) { notify('先填模型名（字母/数字/下划线）', 'bad'); return }
        const r = await post('/train', { ...form, label: form.label || form.name })
        if (!r.ok) { notify(r.message || '无法开始训练', 'bad'); return }
        setTrainResult(null)
        setTrainMsg('')
        setJob(r.job)
        go('train')
      }

      const setWarmupFor = (backend, value) => {
        setWarmups((cur) => ({
          ...cur,
          [backend]: typeof value === 'function' ? value(cur[backend]) : value,
        }))
      }

      const preload = async (which) => {
        if (warmupLockRef.current || warmupBusy) return
        warmupLockRef.current = true
        warmupCancelRef.current = false
        setWarmupFor(which, { status: 'loading', progress: 0.03 })
        try {
          const r = await post('/warmup', { backend: which, voiceId: which === 'rvc' ? voiceId : undefined })
          // 用户已经点了「暂停加载」：以用户操作为准，不再显示成功。
          if (warmupCancelRef.current) {
            setWarmupFor(which, (cur) => (cur ? { ...cur, status: 'cancelled', progress: 0 } : cur))
            return
          }
          const label = which === 'soulx' ? 'SoulX' : 'RVC'
          if (!r.ok) {
            setWarmupFor(which, { status: 'error', progress: 0, message: r.message || '预加载失败' })
            notify(r.message || '预加载失败', 'bad')
            return
          }
          setWarmupFor(which, { status: 'done', progress: 1, device: r.worker?.device || 'cpu' })
          notify(`${label} 模型已常驻（${r.worker?.device || 'cpu'}）`)
          loadState()
        } finally {
          warmupLockRef.current = false
        }
      }

      const stopWarmup = async (which) => {
        const current = warmups[which]
        if (!current || current.status !== 'loading') return
        warmupCancelRef.current = true
        setWarmupFor(which, (cur) => (cur ? { ...cur, status: 'cancelling' } : cur))
        const r = await post('/warmup/cancel', { backend: which })
        if (r && r.cancelled === false) {
          // 取消没生效：模型已经加载完，让 preload 的成功/失败结果正常落地。
          warmupCancelRef.current = false
          return
        }
        if (!r || !r.ok) {
          warmupCancelRef.current = false
          setWarmupFor(which, (cur) => (cur ? { ...cur, status: 'loading' } : cur))
          notify(`暂停失败：${r?.message || '和插件后端的连接中断'}`, 'bad')
          return
        }
        setWarmupFor(which, (cur) => (cur ? { ...cur, status: 'cancelled', progress: 0 } : cur))
        notify('已暂停加载')
        loadState()
      }

      const unloadModel = async (which) => {
        if (unloading[which]) return
        setUnloading((cur) => ({ ...cur, [which]: true }))
        const r = await post('/warmup/unload', { backend: which })
        setUnloading((cur) => ({ ...cur, [which]: false }))
        if (!r.ok) { notify(r.message || '卸载失败', 'bad'); return }
        const label = which === 'soulx' ? 'SoulX' : 'RVC'
        setWarmupFor(which, null)
        notify(r.message || `${label} 模型已卸载，进程已停止`)
        loadState()
      }

      const searchNetease = async () => {
        const q = searchQuery.trim()
        if (!q || searching) return
        setSearching(true)
        setSearchMsg('')
        const r = await get(`/netease/search?q=${encodeURIComponent(q)}&limit=8`)
        setSearching(false)
        if (!r.ok) { setSearchResults(null); setSearchMsg(r.message || '搜索失败'); return }
        setSearchResults(r.results || [])
        if (!(r.results || []).length) setSearchMsg('没搜到，换个关键词试试')
      }

      const importNetease = async (item) => {
        setImportingId(item.id)
        const r = await post('/netease/import', { id: item.id, name: item.name, artists: item.artists })
        setImportingId('')
        if (!r.ok) { setSearchMsg(r.message || '下载失败'); return }
        setSongId(r.song.id)
        setAnalysis(null)
        setAnalysisId('')
        setPlans(null)
        setSelectedId('')
        setAudioUrl('')
        setPlayhead(0)
        setActivePhrase(-1)
        phrasePinnedRef.current = false
        stopAtRef.current = null
        setSearchResults(null)
        setSearchMsg('')
        setSearchQuery('')
        notify(`已添加：${r.song.name}`)
        loadState()
        loadLibrary()
        goStudio('songs')
      }

      // 采集 <audio> 的真实状态；只在异常时上报，不记录任何正文。
      const mediaSnapshot = (el) => {
        const a = el || audioRef.current
        const ranges = (obj) => {
          const out = []
          try {
            for (let i = 0; i < obj.length; i++) out.push([Math.round(obj.start(i) * 100) / 100, Math.round(obj.end(i) * 100) / 100])
          } catch {}
          return out
        }
        const snap = { source: audioSource, variant: coverVariant }
        try {
          snap.src = a && a.currentSrc ? String(a.currentSrc).replace(/^https?:\/\/[^/]+/, '') : ''
          snap.duration = a ? a.duration : null
          snap.currentTime = a ? Math.round(a.currentTime * 1000) / 1000 : null
          snap.readyState = a ? a.readyState : null
          snap.networkState = a ? a.networkState : null
          snap.paused = a ? a.paused : null
          snap.error = a && a.error ? a.error.code : null
          snap.seekable = a ? ranges(a.seekable) : []
          snap.buffered = a ? ranges(a.buffered) : []
        } catch {}
        snap.analysisDuration = Number(analysis?.duration) || null
        return snap
      }

      const reportClient = (kind, data) => {
        try { post('/client-log', { kind, data }) } catch {}
      }

      // 换源 / 换版本时要不要接着自动播放：只有本来就在放（或用户刚点了播放）才继续。
      // 进入插件时音频是暂停的，自动升级 Blob / 回退版本不能自己播起来。
      const shouldKeepPlaying = (el) => {
        const a = el || audioRef.current
        if (a && !a.paused && !a.ended) return true
        const intent = pendingSeekRef.current
        if (intent && intent.play !== false) return true
        return Boolean(wantPlayRef.current)
      }

      // 当前翻唱版本不可跳转 / 加载失败时，自动换另一份（wav <-> mp3）再试一次。
      const tryCoverFallback = (reason, keepTime) => {
        if (!coverMixUrl) return false
        const current = coverVariant === 'wav' ? 'WAV' : 'MP3'
        const next = coverVariant === 'wav' ? 'mix' : 'wav'
        const tag = `${coverMixUrl}|${next}`
        if (coverFallbackRef.current === tag) return false
        coverFallbackRef.current = tag
        const wanted = keepTime != null
          ? Number(keepTime)
          : (pendingSeekRef.current && pendingSeekRef.current.time != null ? Number(pendingSeekRef.current.time) : (Number(playheadRef.current) || 0))
        const at = Number.isFinite(wanted) && wanted >= 0 ? wanted : 0
        const keepStop = stopAtRef.current
        const play = shouldKeepPlaying()
        const snap = mediaSnapshot()
        pendingSeekRef.current = { time: at, stopAt: keepStop, play }
        setCoverUseMix(next === 'mix')
        setAudioNote(`翻唱 ${current} 版本异常（${reason}），已自动切换到 ${next === 'mix' ? 'MP3' : 'WAV'} 版本`)
        reportClient('cover-variant-switch', { reason, target: at, media: snap })
        return true
      }

      // 重新挂一个全新的 <audio>：播放管线卡死时，这是唯一可靠的恢复方式。
      const restartAudio = (reason, keepTime) => {
        const wanted = keepTime != null
          ? Number(keepTime)
          : (pendingSeekRef.current && pendingSeekRef.current.time != null ? Number(pendingSeekRef.current.time) : (Number(playheadRef.current) || 0))
        const at = Number.isFinite(wanted) && wanted >= 0 ? wanted : 0
        const keepStop = stopAtRef.current
        const snap = mediaSnapshot()
        pendingSeekRef.current = { time: at, stopAt: keepStop, play: shouldKeepPlaying(), restarted: true }
        loadedSrcRef.current = ''
        seekGuardRef.current = null
        if (seekVerifyRef.current) { clearTimeout(seekVerifyRef.current); seekVerifyRef.current = null }
        setAudioEpoch((n) => n + 1)
        setAudioNote(reason ? `音频已重载（${reason}）` : '音频已重载')
        reportClient('audio-restart', { reason: reason || '', target: at, media: snap })
      }

      // 把整段音频取回来用 Blob URL 播放：传输层不支持 Range 时，这是唯一能跳转的方式。
      // play 不传时按“原本是否在放”决定：进入插件恢复上次位置时应该保持暂停。
      const upgradeToBlob = (raw, keepTime, play) => {
        if (!raw || raw.startsWith('blob:') || blobSrcsRef.current[raw] || blobPendingRef.current.has(raw)) return
        reportClient('blob-upgrade', { stage: 'needs-seek', target: keepTime, media: mediaSnapshot() })
        setAudioNote('音频不支持在线跳转，正在改用本地缓冲播放…')
        const task = (async () => {
          try {
            const res = await fetch(raw, { cache: 'no-store' })
            if (!res.ok) throw new Error('HTTP ' + res.status)
            const blob = await res.blob()
            if (!blob.size) throw new Error('空音频')
            const url = URL.createObjectURL(blob)
            const keys = Object.keys(blobSrcsRef.current)
            if (keys.length >= 3) {
              const drop = keys[0]
              const old = blobSrcsRef.current[drop]
              if (old) { try { URL.revokeObjectURL(old) } catch {} }
              delete blobSrcsRef.current[drop]
            }
            pendingSeekRef.current = {
              time: Math.max(0, Number(keepTime) || 0),
              stopAt: stopAtRef.current,
              play: play == null ? shouldKeepPlaying() : Boolean(play),
            }
            seekGuardRef.current = null
            setBlobSrcs((prev) => ({ ...prev, [raw]: url }))
            setAudioNote('')
          } catch (error) {
            const message = String((error && error.message) || error)
            reportClient('blob-fail', { stage: 'needs-seek', target: keepTime, media: mediaSnapshot(), reason: message })
            setAudioNote(`本地缓冲失败（${message}），可以点「重载音频」再试`)
          } finally {
            blobPendingRef.current.delete(raw)
          }
        })()
        blobPendingRef.current.set(raw, task)
      }

      // 可跳转区间是否真的可用（seekable 可能是 [0,0] 这种“有长度但不可跳”）。
      const seekableEnd = (el) => {
        try {
          if (!el || !el.seekable.length) return 0
          return el.seekable.end(el.seekable.length - 1)
        } catch { return 0 }
      }
      const canSeek = (el) => seekableEnd(el) > 1

      // 能不能跳转？拿不到可跳转区间就延迟确认一次，再升级成 Blob。
      const maybeUpgradeToBlob = (el, stage) => {
        const raw = rawPlayableUrl
        if (!raw || raw.startsWith('blob:')) return false
        if (blobSrcsRef.current[raw] || blobPendingRef.current.has(raw)) return false
        if (canSeek(el)) return false
        setTimeout(() => {
          const a = audioRef.current
          if (!a || a.error) return
          const src = a.getAttribute('src') || ''
          if (!src || src.startsWith('blob:')) return
          if (canSeek(a)) return
          upgradeToBlob(src, a.currentTime > 0.2 ? a.currentTime : (Number(playheadRef.current) || 0))
        }, 700)
        return true
      }

      const clearStallWatch = () => {
        if (stallTimerRef.current) { clearTimeout(stallTimerRef.current); stallTimerRef.current = null }
      }

      // 播放卡在 waiting 超过 5 秒：重建 <audio>，这就是“清除音频”的效果。
      const onAudioWaiting = () => {
        clearStallWatch()
        stallTimerRef.current = setTimeout(() => {
          stallTimerRef.current = null
          const el = audioRef.current
          if (!el || el.paused || el.ended || el.error) return
          if (el.readyState >= 2) return
          const src = el.getAttribute('src') || ''
          const seat = stallForRef.current
          const fresh = seat.src !== src || Date.now() - seat.at > 60000
          const count = fresh ? 0 : seat.count
          if (count >= 2) {
            setAudioNote('音频一直加载不出来，可以点「重载音频」再试')
            return
          }
          stallForRef.current = { src, count: count + 1, at: Date.now() }
          restartAudio('播放卡住', el.currentTime > 0.2 ? el.currentTime : (Number(playheadRef.current) || 0))
        }, 5000)
      }

      // 只在“加载阶段就失败”时换版本（此时没有播放可被打断），跳转问题一律走重载，绝不中途换源。
      const checkCoverHealth = (el, stage) => {
        if (audioSource !== 'cover' || !coverMixUrl) return false
        if (el.error) {
          return tryCoverFallback(`加载失败 code=${el.error.code}`)
        }
        const d = Number(el.duration)
        if (!Number.isFinite(d) || d <= 0) {
          return tryCoverFallback(`时长未知@${stage}`)
        }
        const ref = Number(analysis?.duration) || 0
        if (ref > 0 && Math.abs(d - ref) > 2) {
          setAudioNote(`翻唱音频时长 ${fmtTime(d)} 与分析 ${fmtTime(ref)} 不一致，进度条按音频时长计算`)
          reportClient('duration-mismatch', { stage, target: null, media: mediaSnapshot(el) })
        }
        return false
      }

      // 当前音源可用的时长：优先用媒体自己的，退回到分析时长。
      const seekLimit = () => {
        const el = audioRef.current
        const d = Number(el && el.duration)
        if (Number.isFinite(d) && d > 0) return d
        return Math.max(0, Number(analysis?.duration) || 0)
      }

      // 真正把跳转写进 <audio>：夹到有效区间，必要时开始播放。
      const applySeek = (el, intent) => {
        if (!el) return
        const limit = seekLimit()
        const upper = limit > 0 ? Math.max(0, limit - 0.05) : Number.POSITIVE_INFINITY
        const t = Math.max(0, Math.min(Number(intent.time) || 0, upper))
        stopAtRef.current = intent.stopAt == null ? null : Math.max(0, Math.min(Number(intent.stopAt) || 0, upper))
        seekGuardRef.current = { time: t, until: Date.now() + 900 }
        try { el.currentTime = t } catch {}
        setPlayhead(t)
        wantPlayRef.current = intent.play !== false
        if (intent.play === false) {
          try { el.pause() } catch {}
          return
        }
        try {
          const p = el.play()
          if (p && p.catch) p.catch(() => {})
        } catch {}
        // 跳转校验：只在“确实没跳过去”时恢复。seek 正在进行 / 数据没到位时继续等，不打断。
        if (seekVerifyRef.current) clearTimeout(seekVerifyRef.current)
        const verify = (attempt) => {
          seekVerifyRef.current = setTimeout(() => {
            seekVerifyRef.current = null
            if (!el.isConnected || el.error) return
            if (el.ended) { wantPlayRef.current = false; return }
            if (el.paused) {
              // 跳转后本该在播放，却停住了：先补一次 play()，还不行就重建 <audio>。
              if (!wantPlayRef.current) return
              if (attempt >= 2) {
                reportClient('play-stuck', { stage: 'verify', target: t, media: mediaSnapshot(el) })
                restartAudio('播放没有恢复', t)
                return
              }
              try {
                const p = el.play()
                if (p && p.catch) p.catch(() => {})
              } catch {}
              verify(attempt + 1)
              return
            }
            if (el.seeking || el.readyState < 2) {
              if (attempt < 5) { verify(attempt + 1) }
              return
            }
            const dur = Number(el.duration)
            if (!Number.isFinite(dur) || dur <= 0) return
            if (t > dur - 0.3) return
            if (Math.abs(el.currentTime - t) <= 2) return
            if (attempt === 0) {
              // 先原地再跳一次，不重载、不换源。
              reportClient('seek-retry', { stage: 'verify', target: t, media: mediaSnapshot(el) })
              try {
                el.currentTime = t
                const p = el.play()
                if (p && p.catch) p.catch(() => {})
              } catch {}
              verify(1)
              return
            }
            reportClient('seek-miss', { stage: 'verify', target: t, media: mediaSnapshot(el) })
            const usable = canSeek(el)
            if (!usable) {
              const src = el.getAttribute('src') || ''
              if (src && !src.startsWith('blob:')) {
                upgradeToBlob(src, t, true)
                return
              }
            }
            if (!intent.restarted) {
              restartAudio('跳转没有被接受', t)
              return
            }
            setAudioNote(usable
              ? '跳转仍然没有生效，可以点「重载音频」再试'
              : '当前音频不支持跳转（浏览器拿不到可跳转区间）')
          }, attempt === 0 ? 900 : 1200)
        }
        verify(0)
      }

      // 恢复上次的播放位置：只定位，不自动播放（切面板回来不应该突然出声）。
      useEffect(() => {
        const at = restorePlayheadRef.current
        if (at == null) return
        const el = audioRef.current
        if (!el || !el.getAttribute('src')) return
        restorePlayheadRef.current = null
        const intent = { time: at, stopAt: null, play: false }
        if (el.readyState >= 1) {
          applySeek(el, intent)
          return
        }
        pendingSeekRef.current = intent
      }, [restoreToken, audioSource, audioUrl, analysis])

      // 统一入口：能立刻跳就立刻跳，媒体还没准备好就排队，等 metadata / canplay。
      const playFrom = (time, opts) => {
        const intent = {
          time: Math.max(0, Number(time) || 0),
          stopAt: opts && opts.stopAt != null ? opts.stopAt : null,
          play: !opts || opts.play !== false,
        }
        const el = audioRef.current
        const total = Math.max(0, Number(totalDuration) || 0)
        setPlayhead(total > 0 ? Math.min(intent.time, total) : intent.time)
        pendingSeekRef.current = intent
        if (!el || !el.getAttribute('src')) return
        if (el.readyState >= 1) {
          pendingSeekRef.current = null
          applySeek(el, intent)
          return
        }
        try { el.load() } catch {}
        try {
          const p = el.play()
          if (p && p.catch) p.catch(() => {})
        } catch {}
      }

      const switchSource = (next) => {
        if (next === 'cover' && !coverUrl) {
          // 还没挂成品时，自动挑当前方案已缓存的版本，其次挑最新的。
          const auto = renderForRow(selected) || renders[0] || null
          if (!auto) return
          selectRender(auto)
          return
        }
        const pinned = phrasePinnedRef.current && activePhraseObj
        const at = pinned ? activePhraseObj.start : Math.max(0, Number(playhead) || 0)
        const stopAt = pinned ? activePhraseObj.end : null
        if (next === audioSource) {
          // 已经在这个音源上：按当前进度（或当前乐句）重新播放，点一下也有反应。
          playFrom(at, { stopAt })
          return
        }
        // 新音源要等 React 把 src 换掉、重新取 metadata 之后再跳。
        pendingSeekRef.current = { time: at, stopAt, play: true }
        loadedSrcRef.current = ''
        setPlayhead(at)
        setAudioSource(next)
      }

      const sourceToggle = () => h('div', { className: 'ss-seg' },
        h('button', {
          type: 'button', className: 'ss-seg-btn' + (audioSource === 'original' ? ' on' : ''),
          onClick: () => switchSource('original'),
        }, '原曲'),
        h('button', {
          type: 'button', className: 'ss-seg-btn' + (audioSource === 'cover' ? ' on' : ''),
          disabled: !coverUrl && !renders.length,
          title: coverUrl || renders.length ? '' : '生成翻唱后可切换',
          onClick: () => switchSource('cover'),
        }, '翻唱'),
      )

      const playPhrase = (index) => {
        const p = phrases[index]
        if (!p) return
        phrasePinnedRef.current = true
        setActivePhrase(index)
        setPlayhead(p.start)
        const nextSource = audioSource === 'cover' && coverUrl ? 'cover' : 'original'
        const target = nextSource === 'cover' ? coverUrl : originalUrl
        if (!target) return
        if (nextSource !== audioSource) {
          pendingSeekRef.current = { time: p.start, stopAt: p.end, play: true }
          loadedSrcRef.current = ''
          setAudioSource(nextSource)
          return
        }
        playFrom(p.start, { stopAt: p.end })
      }

      const clearPhrase = () => {
        setActivePhrase(-1)
        phrasePinnedRef.current = false
        stopAtRef.current = null
        playFrom(0)
      }

      const togglePlay = () => {
        const el = audioRef.current
        if (!el) return
        if (el.paused) {
          const intent = pendingSeekRef.current
          if (intent && el.readyState >= 1) {
            pendingSeekRef.current = null
            applySeek(el, { ...intent, play: true })
            return
          }
          try {
            const p = el.play()
            if (p && p.catch) p.catch(() => {})
          } catch {}
          return
        }
        wantPlayRef.current = false
        try { el.pause() } catch {}
      }

      // 点进度条 / 拖时间轴：定位到这一刻并开始播放。
      const seekTo = (t) => {
        const total = Math.max(0, Number(totalDuration) || 0)
        const raw = Math.max(0, Number(t) || 0)
        const time = total > 0 ? Math.min(raw, total) : raw
        phrasePinnedRef.current = false
        stopAtRef.current = null
        const idx = phrases.findIndex((p) => time >= p.start && time < p.end)
        setActivePhrase(idx)
        playFrom(time)
      }

      const onAudioTime = (e) => {
        const el = e.target
        clearStallWatch()
        const t = el.currentTime
        const guard = seekGuardRef.current
        if (guard && Date.now() < guard.until && Math.abs(t - guard.time) > 0.75) return
        if (guard && Date.now() >= guard.until) seekGuardRef.current = null
        setPlayhead(t)
        if (phrasePinnedRef.current && activePhraseObj && t > activePhraseObj.end + 0.4) {
          phrasePinnedRef.current = false
        }
        const stop = stopAtRef.current
        if (stop != null && t >= stop - 0.04) {
          stopAtRef.current = null
          wantPlayRef.current = false
          try { el.pause() } catch {}
        }
      }

      const onAudioMeta = (e) => {
        const el = e.target
        const limit = Number(el.duration)
        if (Number.isFinite(limit) && limit > 0) setMediaDuration(limit)
        // 翻唱音源每次加载只上报一次状态，方便定位“能播但跳不动”的环境问题。
        if (audioSource === 'cover' && coverMixUrl && coverLoggedRef.current !== coverUrl) {
          coverLoggedRef.current = coverUrl
          reportClient('cover-open', { stage: 'metadata', target: null, media: mediaSnapshot(el) })
        }
        if (checkCoverHealth(el, 'metadata')) return
        maybeUpgradeToBlob(el, 'metadata')
        const intent = pendingSeekRef.current
        if (intent) {
          pendingSeekRef.current = null
          applySeek(el, intent)
          return
        }
        setPlayhead((cur) => (Number.isFinite(limit) && limit > 0 ? Math.min(cur, limit) : cur))
      }

      const onAudioDuration = (e) => {
        const d = Number(e.target.duration)
        if (Number.isFinite(d) && d > 0) setMediaDuration(d)
      }

      const onAudioError = (e) => {
        const el = e.target
        const code = el.error ? el.error.code : 0
        if (checkCoverHealth(el, 'error')) return
        if (audioSource === 'cover' && tryCoverFallback(`加载失败 code=${code}`)) return
        notify(`音频加载失败${code ? `（错误 ${code}）` : ''}`, 'bad')
        reportClient('audio-error', { stage: 'error', target: null, media: mediaSnapshot(el) })
      }

      // metadata 可能在排队之前就已经到过，canplay 再兜一次底。
      const onAudioCanPlay = (e) => {
        const el = e.target
        const d = Number(el.duration)
        if (Number.isFinite(d) && d > 0) setMediaDuration(d)
        if (checkCoverHealth(el, 'canplay')) return
        maybeUpgradeToBlob(el, 'canplay')
        const intent = pendingSeekRef.current
        if (!intent) return
        pendingSeekRef.current = null
        applySeek(el, intent)
      }

      useEffect(() => {
        if (autoWarmed.current) return
        if (envReady && state?.settings?.autoWarmup === true && voiceId) {
          autoWarmed.current = true
          preload('rvc')
        }
      }, [envReady, state?.settings?.autoWarmup, voiceId])

      const navHint = (id) => {
        if (id === 'env') {
          if (!state) return '检查中…'
          if (!envReady) return job && job.type === 'setup' && jobBusy ? `安装中 ${Math.round((job.progress || 0) * 100)}%` : `还缺 ${deps.missing?.length || 0} 项`
          return '环境已就绪'
        }
        if (id === 'train') return job && job.type === 'train' && jobBusy
          ? `训练中 ${Math.round((job.progress || 0) * 100)}%`
          : (trainResult ? `已完成 ${trainResult.label || trainResult.voiceId || ''}` : '训练音色模型')
        if (id === 'studio') {
          const running = renderJobs.filter((j) => j.status === 'running' || j.status === 'queued').length
          if (running) return `队列 ${running} 个任务`
          return song ? song.name : '歌曲、翻唱与队列'
        }
        if (id === 'settings') return settingsDraft && state ? '有未保存的改动' : '通用设置'
        return ''
      }

      const openWorkspace = () => {
        if (!songId) { goStudio('songs'); return }
        if (!analysis) { goStudio('songs'); return }
        if (!selected) { goStudio('plans'); return }
        if (!audioUrl) { goStudio('songs'); return }
        goStudio('timeline')
      }

      const flowStep = (num, title, meta, done, onClick) => h('button', {
        key: num, type: 'button', className: 'ss-flow-row' + (done ? ' done' : ''), onClick,
      },
        h('span', { className: 'ss-flow-num' }, done ? h(NavIcon, { d: ICON.check, size: 14 }) : String(num)),
        h('span', { className: 'ss-flow-main' },
          h('span', { className: 'ss-flow-name' }, title),
          h('span', { className: 'ss-flow-meta' }, meta),
        ),
        h('span', { className: 'ss-flow-arrow' }, h(NavIcon, { d: ICON.arrow, size: 14 })),
      )

      const renderOverview = () => {
        const next = !songId
          ? {
            title: '先添加一首歌',
            desc: '上传整首歌，自动分出人声和伴奏。',
            cta: '去制作', run: () => goStudio('songs'),
          }
          : !analysis
            ? {
              title: '歌曲已就位，下一步分析 F0',
              desc: '先提取音高，再对照音色音域。',
              cta: envReady ? '开始分析' : '去准备环境',
              run: envReady ? analyze : () => go('env'),
              disabled: jobBusy || !voiceId,
            }
            : !selected
              ? {
                title: '分析完成，挑一个八度方案',
                desc: '自动比较几种八度策略，挑覆盖最好的。',
                cta: envReady ? '生成方案' : '去准备环境',
                run: envReady ? plan : () => go('env'),
                disabled: jobBusy,
              }
              : !audioUrl
                ? {
                  title: '方案已选好，生成成品',
                  desc: `${selected.label} · 舒适覆盖 ${pct(selected.coverage.comfort)}。只改人声。`,
                  cta: envReady ? '生成歌曲' : '去准备环境',
                  run: envReady ? render : () => go('env'),
                  disabled: jobBusy || (envReady && backend === 'soulx' && (!soulxReady || !promptReady)),
                }
                : {
                  title: '成品已生成，来试听',
                  desc: '点乐句可以只听那一句。',
                  cta: '去试听', run: () => goStudio('timeline'),
                }
        return h(React.Fragment, null,
          h('div', { className: 'ss-banner' },
            h('span', { className: 'ss-banner-mark' }, h(NavIcon, { d: next.cta === '去试听' ? ICON.speaker : ICON.spark, size: 18 })),
            h('div', { className: 'ss-banner-body' },
              h('div', { className: 'ss-banner-title' }, next.title),
              h('div', { className: 'ss-banner-desc' }, next.desc),
            ),
            h('button', { className: 'ss-btn primary', onClick: next.run, disabled: next.disabled }, next.cta),
          ),
          h('div', { className: 'ss-metrics' },
            h(Metric, {
              label: '原曲舒适区覆盖',
              value: analysis ? pct(analysis.coverage?.comfort) : '—',
              hint: analysis ? `极限区 ${pct(analysis.coverage?.hard)}` : '分析后显示',
            }),
            h(Metric, {
              label: '当前方案覆盖',
              value: selected ? pct(selected.coverage.comfort) : '—',
              hint: selected ? `极限区 ${pct(selected.coverage.hard)} · 变调 ${selected.changes} 次` : '规划后显示',
            }),
            h(Metric, {
              label: '音色舒适区',
              value: profile ? `${noteName(profile.p5)} – ${noteName(profile.p95)}` : '—',
              hint: profile ? `${Math.round(profile.p5)}–${Math.round(profile.p95)} Hz` : '选择音色后显示',
            }),
            h(Metric, {
              label: '分段 / 乐句',
              value: analysis ? `${analysis.sections?.length || 0} / ${analysis.phrases?.length || 0}` : '—',
              hint: plans?.candidates?.length
                ? `候选八度 ${plans.candidates.map((c) => (c.semitones > 0 ? `+${c.semitones}` : c.semitones)).join(' / ')}`
                : '候选八度待规划',
            }),
          ),
          h('div', { className: 'ss-grid ss-overview-grid' },
            h(Card, { title: '制作进度', icon: ICON.overview },
              h('div', { className: 'ss-flow' },
                flowStep(1, '选择歌曲与音色', song ? `${song.name} · ${fmtTime(song.duration)}` : '还没有选择歌曲', Boolean(songId && voiceId), () => goStudio('songs')),
                flowStep(2, '分析人声 F0', analysis ? `${analysis.sections?.length || 0} 段 · ${analysis.phrases?.length || 0} 乐句` : envReady ? '点「分析 F0」开始' : '环境未准备', Boolean(analysis), () => (analysis ? goStudio('timeline') : goStudio('songs'))),
                flowStep(3, '生成八度方案', selected ? `${selected.label} · ${pct(selected.coverage.comfort)}` : '还没有规划', Boolean(selected), () => (selected ? goStudio('plans') : goStudio('songs'))),
                flowStep(4, '生成并试听', audioUrl ? '成品已生成' : '渲染整首翻唱', Boolean(audioUrl), () => (audioUrl ? goStudio('timeline') : goStudio('songs'))),
              ),
              h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 } },
                h('button', { className: 'ss-btn primary', onClick: openWorkspace }, !analysis ? '继续制作' : !selected ? '去规划' : !audioUrl ? '去生成' : '去试听'),
                h('button', { className: 'ss-btn ghost', onClick: () => go('settings') }, '打开设置'),
              ),
            ),
            h(Card, { title: '最近任务', icon: ICON.clock, right: h('span', { className: 'ss-tag' }, `${state?.jobs?.length || 0} 条`) },
              h('div', { className: 'ss-history' },
                (state?.jobs || []).slice(0, 6).map((j) => h('div', { key: j.id, className: 'ss-history-row' },
                  h('span', { className: 'ss-history-main' },
                    h('span', { className: 'ss-history-name' }, `${jobType(j.type)} · ${j.stage || j.status}`),
                    h('span', { className: 'ss-history-meta' }, fmtAgo(j.createdAt)),
                  ),
                  h('span', { className: 'ss-tag ' + statusTone(j.status) }, jobLabel(j.status)),
                )),
                !(state?.jobs || []).length ? h('div', { className: 'ss-note' }, '还没有任务。') : null,
              ),
              h('div', { className: 'ss-note', style: { marginTop: 10 } }, '切页不会中断后台任务。'),
            ),
          ),
        )
      }

      const renderStudio = () => {
        const libSong = library.find((s) => s.id === songId) || null
        const songCovers = libSong?.renders || []
        const activeRenderJobs = renderJobs
          .filter((j) => j.status === 'queued' || j.status === 'running')
          .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
        const recentRenderJobs = renderJobs
          .filter((j) => j.status === 'done' && (!j.endedAt || Date.now() - j.endedAt < 10 * 60 * 1000))
          .slice(0, 3)
        const queueRows = [...activeRenderJobs, ...recentRenderJobs]
        const queueCard = queueRows.length ? h(Card, {
          title: '生成队列',
          icon: ICON.clock,
          desc: '可以连续加入多个生成任务；完成一个会提醒，切页不会中断。',
          right: h('span', { className: 'ss-tag' }, `${activeRenderJobs.length} 个进行中 / 排队`),
        },
          queueRows.map((j) => h('div', { key: j.id, className: 'ss-queue-row' },
            h('span', { className: 'ss-tag ' + statusTone(j.status) }, jobLabel(j.status)),
            h('div', { className: 'ss-queue-main' },
              h('div', { className: 'ss-queue-title' },
                `${j.meta?.songName || '歌曲'} · ${planLevelLabel(j.meta?.planLabel)} · ${j.meta?.backend === 'soulx' ? 'SoulX' : 'RVC'}`),
              h('div', { className: 'ss-bar', style: { marginTop: 2 } }, h('i', { style: { width: `${Math.round((j.progress || 0) * 100)}%` } })),
              h('div', { className: 'ss-job-msg' }, j.message || j.stage || ''),
            ),
            h('span', { className: 'ss-job-pct' }, `${Math.round((j.progress || 0) * 100)}%`),
            (j.status === 'queued' || j.status === 'running')
              ? h('button', { className: 'ss-btn sm ghost', onClick: () => cancelRenderJob(j.id) }, '取消')
              : null,
          )),
        ) : null
        const libraryCard = h(Card, {
          title: '歌曲库',
          icon: ICON.studio,
          desc: '已下载的歌曲；点一首歌继续分析或生成。',
          right: h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h('button', { className: 'ss-btn sm ghost', onClick: () => loadLibrary(), disabled: libraryLoading }, libraryLoading ? '刷新中…' : '刷新'),
            h('button', { className: 'ss-btn sm', onClick: () => fileRef.current?.click(), disabled: uploading }, uploading ? '上传中…' : '上传新歌'),
          ),
        },
          library.length
            ? h('div', { className: 'ss-song-grid' }, library.map((s) => h('button', {
              key: s.id, type: 'button', title: s.name,
              className: 'ss-song' + (s.id === songId ? ' on' : ''),
              onClick: () => pickSong(s.id),
            },
              h('span', { className: 'ss-song-name' }, s.name),
              h('span', { className: 'ss-song-meta' }, `${fmtTime(s.duration)} · ${s.analyses?.length || 0} 次分析`),
              h('span', { className: 'ss-song-tags' },
                h('span', { className: 'ss-tag ' + (s.coverCount ? 'good' : '') }, s.coverCount ? `已翻唱 ${s.coverCount} 版` : '未翻唱'),
                s.latestCover ? h('span', { className: 'ss-tag' }, fmtAgo(s.latestCover.createdAt)) : null,
              ),
            )))
            : h('div', { className: 'ss-note' }, libraryLoading ? '正在读取歌曲库…' : '还没有歌曲；用下面的网易云搜索或「上传新歌」添加。'),
        )
        const coversCard = h(Card, {
          title: '已翻唱的版本',
          icon: ICON.speaker,
          style: { marginTop: 14 },
          desc: songCovers.length ? '可以直接试听 / 下载，也可以再生成一版。' : '按下面的分析 → 方案 → 生成走完，成品会出现在这里。',
          right: libSong
            ? h('span', { className: 'ss-tag ' + (songCovers.length ? 'good' : '') }, songCovers.length ? `${songCovers.length} 版` : '还没有翻唱')
            : null,
        },
          !songId
            ? h('div', { className: 'ss-note' }, '先在歌曲库里选一首歌。')
            : songCovers.length
              ? songCovers.map((c) => h('div', { key: c.id, className: 'ss-cover-row' },
                h('div', { className: 'ss-cover-main' },
                  h('div', { className: 'ss-cover-title' }, `${planLevelLabel(c.level)} · ${c.backend === 'soulx' ? 'SoulX' : 'RVC'}`),
                  h('div', { className: 'ss-cover-meta' },
                    `${fmtAgo(c.createdAt)} · 舒适覆盖 ${c.coverage?.comfort != null ? pct(c.coverage.comfort) : '—'}${c.duration ? ` · ${fmtTime(c.duration)}` : ''}`),
                ),
                h('audio', { controls: true, preload: 'none', src: c.audioUrl }),
                h('a', { className: 'ss-btn sm ghost', href: c.audioUrl, download: 'cover.mp3' }, '下载'),
              ))
              : h('div', { className: 'ss-note' }, '这首歌还没有翻唱版本；按下面的步骤分析、选方案、生成。'),
        )
        return h(React.Fragment, null,
        h(PageIntro, {
          icon: ICON.studio,
          title: '制作台',
          desc: '歌曲库与翻唱版本；没有翻唱的歌按「分析 F0 → 八度方案 → 生成」走。',
          right: h('span', { className: 'ss-tag ' + (state ? (envReady ? 'good' : 'warn') : '') }, state ? (envReady ? '环境就绪' : '环境未准备') : '读取中…'),
        }),
        queueCard,
        libraryCard,
        h(Card, {
          title: '从网易云找歌',
          icon: ICON.download,
          desc: '免费歌直接下载；会员歌先在设置里填 Cookie。',
          right: state?.settings?.neteaseCookieSet ? h('span', { className: 'ss-tag good' }, 'Cookie 已设置') : null,
        },
          h('div', { className: 'ss-search-row' },
            h('input', {
              className: 'ss-input', placeholder: '搜歌名 / 歌手', value: searchQuery,
              onChange: (e) => setSearchQuery(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); searchNetease() } },
            }),
            h('button', {
              className: 'ss-btn primary', onClick: searchNetease,
              disabled: searching || !searchQuery.trim(),
            }, searching ? '搜索中…' : '搜索'),
          ),
          searchMsg ? h('div', { className: 'ss-note', style: { marginTop: 8, color: 'var(--dsw-alias-state-warn-primary)' } }, searchMsg) : null,
          searchResults && searchResults.length
            ? h('div', { className: 'ss-search-list' },
              searchResults.map((r) => h('div', { key: r.id, className: 'ss-search-item' },
                h('div', { className: 'ss-search-main' },
                  h('div', { className: 'ss-search-title' }, r.name, r.alias ? h('span', { className: 'ss-search-alias' }, r.alias) : null),
                  h('div', { className: 'ss-search-meta' }, `${r.artists || '未知歌手'} · ${fmtTime(r.durationSec)}`),
                ),
                r.vip ? h('span', { className: 'ss-tag warn' }, 'VIP') : null,
                h('button', {
                  className: 'ss-btn sm primary',
                  disabled: Boolean(importingId),
                  onClick: () => importNetease(r),
                }, String(importingId) === String(r.id) ? '下载中…' : '下载'),
              )),
            )
            : null,
        ),
        h(Card, {
          title: '① 选择素材',
          icon: ICON.upload,
          desc: '歌曲和音色决定分析结果。',
        },
          h('div', { className: 'ss-form-grid' },
            h('div', { className: 'ss-field' },
              h('label', null, '歌曲'),
              h('select', {
                className: 'ss-select', value: songId,
                onChange: (e) => pickSong(e.target.value),
              },
                h('option', { value: '' }, '选择已上传歌曲…'),
                songs.map((s) => h('option', { key: s.id, value: s.id }, `${s.name} · ${fmtTime(s.duration)}`)),
              ),
            ),
            h('div', { className: 'ss-field' },
              h('label', null, '音色模型'),
              h('select', {
                className: 'ss-select', value: voiceId,
                onChange: (e) => {
                  setVoiceId(e.target.value)
                  setAnalysis(null)
                  setAnalysisId('')
                  setPlans(null)
                  setSelectedId('')
                  setAudioUrl('')
                  setPlayhead(0)
                },
              },
                h('option', { value: '' }, '选择音色模型…'),
                voices.map((v) => h('option', {
                  key: v.id, value: v.id, disabled: !v.calibrated,
                }, `${v.label}${v.calibrated ? ` · ${noteName(v.profile.p5)}–${noteName(v.profile.p95)}` : ' · 未校准'}`)),
              ),
              voices.length ? null : h('div', { className: 'ss-note', style: { marginTop: 6 } },
                '还没有音色模型：去「RVC训练」训练一个，或把 .pth 放到音色模型目录（见「设置」页）。'),
            ),
          ),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 11 } },
            h('button', { className: 'ss-btn ghost', onClick: () => fileRef.current?.click(), disabled: uploading }, uploading ? '上传中…' : '上传新歌'),
            song ? h('span', { className: 'ss-tag' }, fmtTime(song.duration)) : null,
          ),
          voice?.profile ? h('div', { className: 'ss-note', style: { marginTop: 9 } },
            `舒适区 ${noteName(voice.profile.p5)}–${noteName(voice.profile.p95)} · 极限区 ${noteName(voice.profile.p1)}–${noteName(voice.profile.p99)}`,
          ) : null,
          h('div', { className: 'ss-backends' },
            h('button', {
              type: 'button', className: 'ss-backend' + (backend === 'rvc' ? ' on' : ''), 'aria-pressed': backend === 'rvc',
              onClick: () => setBackend('rvc'),
            },
              h('span', { className: 'ss-backend-radio' }),
              h('span', { className: 'ss-backend-body' },
                h('span', { className: 'ss-backend-title' }, 'RVC · 已训练音色'),
                h('span', { className: 'ss-backend-desc' }, '速度快。'),
              ),
              h('span', { className: 'ss-tag ' + (state?.settings?.checks?.rvc ? 'good' : 'warn') }, state?.settings?.checks?.rvc ? '就绪' : '缺失'),
            ),
            h('button', {
              type: 'button', className: 'ss-backend' + (backend === 'soulx' ? ' on' : ''), 'aria-pressed': backend === 'soulx',
              onClick: () => setBackend('soulx'),
            },
              h('span', { className: 'ss-backend-radio' }),
              h('span', { className: 'ss-backend-body' },
                h('span', { className: 'ss-backend-title' }, 'SoulX-SVC · 零样本'),
                h('span', { className: 'ss-backend-desc' }, '参考音频克隆，首次慢。'),
              ),
              h('span', { className: 'ss-tag ' + (soulxReady ? 'good' : 'warn') }, soulxReady ? '就绪' : '未安装'),
            ),
          ),
        ),
        h(Card, {
          title: '② 开始处理',
          icon: ICON.spark,
          style: { marginTop: 14 },
          right: h('span', { className: 'ss-tag ' + (soulxReady ? 'good' : '') }, backend === 'soulx' ? 'SoulX 后端' : 'RVC 后端'),
        },
          h('div', { className: 'ss-actions' },
            h('div', { className: 'ss-action' },
              h('span', { className: 'ss-action-num' }, '1'),
              h('h4', null, '分析 F0'),
              h('p', null, '提取人声音高。'),
              h('button', { className: 'ss-btn primary', onClick: analyze, disabled: !envReady || !songId || !voiceId || jobBusy }, jobBusy ? '处理中…' : '分析 F0'),
            ),
            h('div', { className: 'ss-action' },
              h('span', { className: 'ss-action-num' }, '2'),
              h('h4', null, '超音域处理'),
              h('p', null, '自动生成八度方案。'),
              h('button', { className: 'ss-btn', onClick: plan, disabled: !envReady || !analysis || jobBusy }, '生成方案'),
            ),
            h('div', { className: 'ss-action' },
              h('span', { className: 'ss-action-num' }, '3'),
              h('h4', null, '生成歌曲'),
              h('p', null, '按方案生成成品。'),
              h('button', {
                className: 'ss-btn primary', onClick: render,
                disabled: !envReady || !selected || jobBusy || (backend === 'soulx' && (!soulxReady || !promptReady)),
                title: backend === 'soulx' && !soulxReady ? 'SoulX 未安装'
                  : backend === 'soulx' && !promptReady ? '当前音色没有 promptWav 参考音频' : '',
              }, '生成歌曲'),
            ),
          ),
          job ? h(JobProgress, { job, onCancel: cancel }) : null,
          job?.error ? h('div', { className: 'ss-warn' }, job.error) : null,
          state && !envReady ? h('div', { className: 'ss-warn' },
            `环境还缺 ${deps.missing?.length || 0} 项，分析和生成暂不可用。`,
            h('button', { className: 'ss-btn sm', onClick: () => go('env') }, '去环境准备'),
          ) : null,
          backend === 'soulx' && !soulxReady
            ? h('div', { className: 'ss-warn' }, 'SoulX 未就绪；在「环境」页准备，或在设置里改路径。')
            : null,
          backend === 'soulx' && soulxReady && !promptReady
            ? h('div', { className: 'ss-warn' }, '当前音色没有 promptWav 参考音频。')
            : null,
        ),
        coversCard,
        h(SettingsPanel, {
          state, draft: settingsDraft, setDraft: setSettingsDraft, onSaved: loadState, toast: notify,
          groups: SETTING_GROUPS.filter((g) => g.page === 'studio'),
          title: '制作台设置',
          desc: '网易云、八度规划、F0 分析和 SoulX 参数；保存后自动检查环境。',
          showChecks: false, inline: true,
        }),
        )
      }

      const renderTrain = () => {
        const f = trainForm
        const training = state?.training || null
        const trainJob = job && job.type === 'train' ? job : null
        const busy = Boolean(trainJob && (trainJob.status === 'queued' || trainJob.status === 'running'))
        const result = busy ? null : ((trainJob && trainJob.result) || trainResult)
        const canStart = Boolean(training?.ok) && !busy && !jobBusy && Boolean(String(f.datasetPath || '').trim()) && Boolean(String(f.name || '').trim())
        const field = (label, control, help, wide) => h('div', { className: 'ss-field' + (wide ? ' wide' : '') },
          h('label', null, label),
          control,
          help ? h('span', { className: 'ss-help' }, help) : null,
        )
        const numInput = (key, min, max, step) => h('input', {
          className: 'ss-input', type: 'number', min, max, step: step || 1, value: f[key],
          onChange: (e) => patchTrain({ [key]: e.target.value === '' ? '' : Number(e.target.value) }),
        })
        const select = (key, options) => h('select', {
          className: 'ss-select', value: f[key], onChange: (e) => patchTrain({ [key]: e.target.value }),
        }, options.map(([value, label]) => h('option', { key: value, value }, label)))
        const toggle = (key, label) => h('label', {
          className: 'ss-help', style: { display: 'flex', alignItems: 'center', gap: 8, minHeight: 36, cursor: 'pointer' },
        },
          h('input', { type: 'checkbox', checked: Boolean(f[key]), onChange: (e) => patchTrain({ [key]: e.target.checked }) }),
          label,
        )
        return h(React.Fragment, null,
          h(PageIntro, {
            icon: ICON.train,
            title: 'RVC训练',
            desc: '用唱歌数据训练 RVC 音色；完成后自动生成音域 Profile，并给出可复制的权重路径。',
            right: training
              ? h('span', { className: 'ss-tag ' + (training.ok ? 'good' : 'warn') },
                training.ok ? '训练环境就绪' : `缺少 ${training.missing?.length || 0} 项`)
              : null,
          }),
          training && !training.ok ? h('div', { className: 'ss-warn' },
            `训练环境还没准备好：${training.missing.map((x) => x.label).join('、')}。`,
            h('button', { className: 'ss-btn sm', onClick: () => go('env') }, '去环境准备'),
          ) : null,

          h(Card, {
            title: '① 训练数据',
            icon: ICON.upload,
            desc: '填一个装着唱歌音频的文件夹；支持子目录，wav / flac / mp3 / m4a / ogg 都行。',
          },
            h('div', { className: 'ss-train-path' },
              h('input', {
                className: 'ss-input', placeholder: '/Users/you/datasets/my_voice',
                value: f.datasetPath,
                onChange: (e) => { patchTrain({ datasetPath: e.target.value }); setTrainCheck(null); setTrainMsg('') },
                onBlur: () => { if (String(f.datasetPath || '').trim()) checkDataset(false) },
              }),
              h('button', { className: 'ss-btn', disabled: trainChecking, onClick: () => checkDataset(true) },
                trainChecking ? '检查中…' : '检查目录'),
            ),
            trainCheck
              ? (trainCheck.ok
                ? h('div', { className: 'ss-train-check ok' },
                  `找到 ${trainCheck.files} 个音频 · ${fmtMB(trainCheck.bytes)}`,
                  trainCheck.samples?.length ? ` · 例如 ${trainCheck.samples.slice(0, 3).join('、')}` : '')
                : h('div', { className: 'ss-train-check bad' }, trainCheck.message || '目录不可用'))
              : h('div', { className: 'ss-help', style: { marginTop: 8 } },
                '建议 3–15 分钟干净人声（干声最好，少混响、少伴奏）；训练数据越接近目标唱法，效果越好。'),
            trainMsg ? h('div', { className: 'ss-train-check bad' }, trainMsg) : null,
          ),

          h(Card, {
            title: '② 训练参数',
            icon: ICON.settings,
            desc: '默认值适合大多数唱歌数据；不确定就保持默认。',
            style: { marginTop: 14 },
          },
            h('div', { className: 'ss-form-grid' },
              field('模型名', h('input', {
                className: 'ss-input', placeholder: 'my_voice', value: f.name,
                onChange: (e) => { patchTrain({ name: e.target.value.replace(/\s+/g, '_') }); setTrainMsg('') },
              }), '只能用字母、数字、下划线、短横线；也是 .pth 文件名和音色 id。'),
              field('显示名（可选）', h('input', {
                className: 'ss-input', placeholder: '例如：大肥鱼 2 号', value: f.label,
                onChange: (e) => patchTrain({ label: e.target.value }),
              }), '在音色下拉框里显示的名字，留空就用模型名。'),
              field('采样率', select('sr', [['48k', '48k · 最高质量（有预训练底模）'], ['40k', '40k · 平衡'], ['32k', '32k · 更快更省']]),
                '越高越接近原声，训练和推理也更慢；48k + v2 有官方底模，收敛最快。'),
              field('总轮数', numInput('epochs', 1, 500), '遍历数据集的次数。默认 20；越大越像，但更慢、也容易过拟合。'),
            ),
            h('details', { className: 'ss-settings-section', style: { marginTop: 10 } },
              h('summary', null,
                h('span', { className: 'ss-settings-summary' },
                  h('span', { className: 'ss-settings-title' }, '高级参数'),
                  h('span', { className: 'ss-settings-desc' }, '版本 / 批大小 / 切片 / F0 / 设备 / 底模 / 索引；默认折叠'),
                ),
                h('span', { className: 'ss-settings-chevron' }, h(NavIcon, { d: ICON.chevron, size: 14 })),
              ),
              h('div', { className: 'ss-form-grid', style: { marginTop: 10 } },
                field('模型版本', select('version', [['v2', 'v2 · 音质更好'], ['v1', 'v1 · 更省资源']]),
                  'v2 用更大的 HuBERT 特征，音质更好；v1 更轻。'),
                field('批大小', numInput('batchSize', 1, 32), '每步同时处理多少片段。显存/内存不够就调小，默认 4。'),
                field('保存间隔', numInput('saveEvery', 1, 100), '每多少轮保存一次训练检查点；取消或失败时可以保留中间状态。'),
                field('切片长度（秒）', numInput('per', 1, 10, 0.1), '每条训练片段最长几秒。太长吃显存，太短会丢上下文，默认 3.7。'),
                field('F0 提取方法', select('f0Method', [['rmvpe', 'rmvpe · 更准（推荐）'], ['pm', 'pm · 更快']]),
                  '人声音高提取算法；rmvpe 质量更好但更慢。'),
                field('并行进程', numInput('nP', 1, 8), '切分音频和提取 F0 时的并行数；越小越稳，默认 2。'),
                field('训练设备', select('device', [['auto', 'auto · 有 CUDA 用 GPU'], ['cuda', 'cuda · 强制 GPU'], ['cpu', 'cpu · 强制 CPU']]),
                  'auto 会检测 CUDA；Apple Silicon 走 CPU，训练会比较慢。'),
                field('预训练底模', toggle('pretrained', '使用 RVC 官方 48k 底模'),
                  '从官方底模开始收敛快很多；取消则从零训练，需要更多轮数。'),
                field('检索索引', toggle('index', '训练完成后构建 faiss 索引'),
                  '索引用于相似度检索，配合设置里的「索引率」使用；不影响模型本身。'),
              ),
            ),
          ),

          h(Card, {
            title: '③ 开始训练',
            icon: ICON.spark,
            desc: '训练会占用任务队列，切页或切到其他面板都不会中断。',
            style: { marginTop: 14 },
          },
            h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
              h('button', { className: 'ss-btn primary', disabled: !canStart, onClick: startTraining },
                busy ? '训练中…' : '开始训练'),
              h('button', { className: 'ss-btn ghost', onClick: () => checkDataset(true), disabled: trainChecking }, '检查数据'),
              result ? h('span', { className: 'ss-tag good' }, `最近完成：${result.label || result.voiceId || ''}`) : null,
            ),
            h('div', { className: 'ss-help', style: { marginTop: 8 } },
              '训练在后台进程里跑，进度、预计剩余时间和拟合度会按 epoch 更新；取消会停掉正在训练的进程。'),
            training && training.ok && !training.pretrainedReady && f.pretrained && f.sr === '48k' && f.version === 'v2'
              ? h('div', { className: 'ss-warn', style: { marginTop: 8 } },
                '缺少 48k 预训练底模（f0G48k / f0D48k）。去「环境」页一键准备，或取消「使用预训练底模」从零训练。',
                h('button', { className: 'ss-btn sm', onClick: () => go('env') }, '去环境准备'))
              : null,
            state && state.deps?.devices?.rvc?.device !== 'cuda'
              ? h('div', { className: 'ss-help', style: { marginTop: 6 } }, '当前没有检测到 CUDA，训练会走 CPU，速度会比较慢。')
              : null,
            trainJob ? h(TrainProgress, { job: trainJob, onCancel: cancel }) : null,
            result ? h('div', { className: 'ss-train-result', style: { marginTop: 14 } },
              h('div', { className: 'ss-job-top' },
                h('span', { className: 'ss-tag good' }, '训练完成'),
                h('span', { className: 'ss-job-stage' }, `${result.label || result.voiceId || ''} · ${result.sr || ''} ${result.version || ''}`),
              ),
              h('div', { className: 'ss-kv', style: { marginTop: 9 } },
                h('span', { className: 'k' }, '权重'),
                h('span', { className: 'v' }, result.modelPath || '—'),
                h('span', { className: 'k' }, 'Profile'),
                h('span', { className: 'v' }, result.profilePath || '未生成（需要手动补）'),
                h('span', { className: 'k' }, '轮数 / 切片'),
                h('span', { className: 'v' }, `${result.epochs || '—'} 轮 · ${result.slices || '—'} 切片`),
                h('span', { className: 'k' }, '最终 mel loss'),
                h('span', { className: 'v' }, result.finalLoss == null ? '—' : Number(result.finalLoss).toFixed(2)),
                h('span', { className: 'k' }, '拟合度'),
                h('span', { className: 'v' }, result.fit == null ? '—' : `${Number(result.fit).toFixed(1)}%`),
                h('span', { className: 'k' }, '训练目录'),
                h('span', { className: 'v' }, result.expDir || '—'),
              ),
              h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 } },
                h('button', {
                  className: 'ss-btn primary',
                  onClick: () => { if (result.voiceId && result.profilePath) setVoiceId(result.voiceId); goStudio('songs') },
                }, '用这个音色去制作'),
                h('button', { className: 'ss-btn ghost', onClick: () => copyText(result.modelPath || '', '权重路径') }, '复制权重路径'),
                result.profilePath ? h('button', { className: 'ss-btn ghost', onClick: () => copyText(result.profilePath, 'Profile 路径') }, '复制 Profile 路径') : null,
              ),
            ) : null,
          ),
        )
      }

      const renderTimeline = () => {
        if (!analysis) {
          return h(React.Fragment, null,
            h(PageIntro, { icon: ICON.timeline, title: '时间轴', desc: '分析完成后显示音高与乐句。' }),
            h(Empty, {
              icon: ICON.timeline,
              title: '还没有时间轴',
              desc: '先分析 F0。',
              actions: h(React.Fragment, null,
                h('button', { className: 'ss-btn primary', onClick: () => goStudio('songs') }, '去制作'),
                h('button', { className: 'ss-btn ghost', onClick: () => go('env') }, '检查环境'),
              ),
            }),
          )
        }
        if (!profile) {
          return h(React.Fragment, null,
            h(PageIntro, { icon: ICON.timeline, title: '时间轴', desc: '缺少音色音域数据。' }),
            h(Empty, {
              icon: ICON.alert,
              title: '音色 profile 不完整',
              desc: '换一个已校准的音色试试。',
              actions: h('button', { className: 'ss-btn primary', onClick: () => goStudio('songs') }, '换音色'),
            }),
          )
        }
        const origCov = coverageFor({ shifts: [] }, rangeProfile)
        const planCov = activePlan ? coverageFor(activePlan, rangeProfile) : null
        return h(React.Fragment, null,
          h(PageIntro, {
            icon: ICON.timeline,
            title: '时间轴',
            desc: '点乐句高亮并试听；拖动时间轴可定位。',
            right: h('div', { className: 'ss-pills' },
              h('span', { className: 'ss-pill ok' }, `${analysis.sections?.length || 0} 段`),
              h('span', { className: 'ss-pill' }, `${analysis.phrases?.length || 0} 乐句`),
              h('span', { className: 'ss-pill ' + (onCover ? 'ok' : '') },
                onCover && selectedRender ? `翻唱 · ${renderBase(selectedRender)}` : '原曲'),
              onCover && activePlan && activePlan.label ? h('span', { className: 'ss-pill' }, activePlan.label) : null,
            ),
          }),
          h('div', { className: 'ss-grid ss-main-side' },
            h(Card, {
              title: '音高时间轴',
              icon: ICON.timeline,
              right: h('span', { className: 'ss-tag' }, `${phrases.length} 句`),
            },
              h('div', { className: 'ss-legend', style: { marginTop: 0, marginBottom: 8 } },
                h('span', null, h('i', { style: { background: 'var(--dsw-alias-brand-primary)' } }), '舒适区 F0'),
                h('span', null, h('i', { style: { background: 'var(--dsw-alias-state-warn-primary)' } }), '极限区内'),
                h('span', null, h('i', { style: { background: 'var(--dsw-alias-state-error-primary)' } }), '超出极限区'),
                h('span', null, h('i', { style: { background: 'var(--dsw-alias-label-primary)' } }), '处理后（虚线）'),
              ),
              h(Timeline, {
                analysis, plan: activePlan, profile: rangeProfile, playhead, phrase: activePhraseObj,
                onSeek: seekTo,
              }),
              h('div', { className: 'ss-phrase-bar' },
                h('button', {
                  type: 'button', className: 'ss-phrase' + (activePhrase < 0 ? ' on' : ''),
                  onClick: clearPhrase,
                }, '全曲'),
                phrases.map((p, i) => h('button', {
                  key: i, type: 'button',
                  className: 'ss-phrase' + (activePhrase === i ? ' on' : ''),
                  title: `${fmtTime(p.start)} – ${fmtTime(p.end)}`,
                  onClick: () => playPhrase(i),
                },
                  h('b', null, `#${i + 1}`),
                  h('span', null, `${fmtShort(p.start)}–${fmtShort(p.end)}`),
                )),
              ),
              h('div', { className: 'ss-phrase-info' },
                h('span', { className: 'ss-note' },
                  activePhraseObj
                    ? `第 ${activePhrase + 1} 句 · ${fmtTime(activePhraseObj.start)} – ${fmtTime(activePhraseObj.end)}`
                    : phrases.length ? '点乐句试听该句' : '这首歌没有切出乐句',
                ),
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                  sourceToggle(),
                  analysis.songId
                    ? h('a', { className: 'ss-btn sm ghost', href: `${API}/audio?kind=vocals&id=${analysis.songId}`, download: 'vocals.wav' }, '下载人声')
                    : null,
                ),
              ),
            ),
            h(Card, { title: '音色区间', icon: ICON.studio },
              h('div', { className: 'ss-note' },
                onCover && renderVoice ? `${renderVoice.label}${activePlan?.label ? ` · ${activePlan.label}` : ''}` : '当前音色',
                h('br'),
                `舒适区 ${noteName(rangeProfile.p5)}–${noteName(rangeProfile.p95)}`, h('br'),
                `极限区 ${noteName(rangeProfile.p1)}–${noteName(rangeProfile.p99)}`,
              ),
              h('div', { className: 'ss-check' },
                h('span', { className: 'ss-tag ' + ((origCov ?? 0) >= (plans?.target ?? 0.95) ? 'good' : 'warn') },
                  `原曲覆盖 ${origCov == null ? '—' : pct(origCov)}`),
                planCov == null ? null : h('span', { className: 'ss-tag ' + (planCov >= (plans?.target ?? 0.95) ? 'good' : 'warn') },
                  `方案覆盖 ${pct(planCov)}`),
              ),
              h('div', { className: 'ss-note', style: { marginTop: 10 } },
                renders.length
                  ? `播放条可切换原曲 / 已缓存的 ${renders.length} 个翻唱版本，这里的音域和变调会跟着变。`
                  : '生成翻唱后可在播放条切换原曲 / 翻唱。',
              ),
            ),
          ),
        )
      }

      const renderPlans = () => {
        if (!analysis) {
          return h(React.Fragment, null,
            h(PageIntro, { icon: ICON.plans, title: '方案', desc: '对比不同八度策略。' }),
            h(Empty, {
              icon: ICON.plans,
              title: '还没有方案',
              desc: '先分析人声 F0。',
              actions: h('button', { className: 'ss-btn primary', onClick: () => goStudio('songs') }, '去分析'),
            }),
          )
        }
        if (!plans) {
          return h(React.Fragment, null,
            h(PageIntro, { icon: ICON.plans, title: '方案', desc: '分析已完成，生成八度方案。', right: h('span', { className: 'ss-tag good' }, `原曲覆盖 ${pct(analysis.coverage?.comfort)}`) }),
            h(Empty, {
              icon: ICON.spark,
              title: '生成第一组方案',
              desc: '自动比较几种八度策略。',
              actions: h('button', { className: 'ss-btn primary', onClick: plan, disabled: !envReady || jobBusy }, envReady ? '生成方案' : '环境未准备'),
            }),
          )
        }
        return h(React.Fragment, null,
          h(PageIntro, {
            icon: ICON.plans,
            title: '方案',
            desc: '选覆盖最高、变调最少的方案。',
            right: h('div', { className: 'ss-pills' },
              h('span', { className: 'ss-pill ok' }, `目标 ${pct(plans.target)}`),
              h('span', { className: 'ss-pill' }, `${plans.table.length} 个候选`),
            ),
          }),
          h('div', { className: 'ss-grid ss-main-side' },
            h(Card, { title: '方案对比', icon: ICON.plans },
              h('div', { className: 'ss-table-wrap' },
                h('table', { className: 'ss-table' },
                  h('thead', null, h('tr', null,
                    h('th', null, ''),
                    h('th', null, '策略'),
                    h('th', null, '舒适覆盖'),
                    h('th', null, '极限覆盖'),
                    h('th', null, '变调'),
                    h('th', null, '未解决'),
                    h('th', null, '成品'),
                  )),
                  h('tbody', null, plans.table.map((row) => {
                    const cached = renderForRow(row)
                    return h('tr', {
                      key: row.id,
                      className: row.id === selectedId ? 'sel' : '',
                      onClick: () => pickPlan(row.id),
                    },
                      h('td', null, h('input', {
                        className: 'ss-radio', type: 'radio', checked: row.id === selectedId,
                        onChange: () => pickPlan(row.id),
                      })),
                      h('td', null, h('strong', null, row.label), row.id === plans.selectedId ? h('span', { className: 'ss-tag good', style: { marginLeft: 6 } }, '推荐') : null),
                      h('td', null, pct(row.coverage.comfort)),
                      h('td', null, pct(row.coverage.hard)),
                      h('td', null, String(row.changes)),
                      h('td', null, row.unresolved?.length ? h('span', { className: 'ss-tag warn' }, String(row.unresolved.length)) : h('span', { className: 'ss-tag good' }, '0')),
                      h('td', null, cached
                        ? h('button', {
                          type: 'button', className: 'ss-btn sm ghost',
                          onClick: (e) => {
                            e.stopPropagation()
                            pickPlan(row.id)
                            selectRender(cached, { at: 0 })
                            goStudio('timeline')
                          },
                        }, '试听')
                        : h('span', { className: 'ss-note' }, '未生成')),
                    )
                  })),
                ),
              ),
              selected && selected.coverage.comfort < (plans.target ?? 0.95) ? h('div', { className: 'ss-warn' },
                `当前方案覆盖 ${pct(selected.coverage.comfort)}，没到目标 ${pct(plans.target ?? 0.95)}。八度折叠解决不了音域过宽，换音色或换后端试试。`,
              ) : null,
              selected?.unresolved?.length ? h('div', { className: 'ss-note', style: { marginTop: 8 } },
                '仍越界的乐句：' + selected.unresolved.slice(0, 6).map((u) => `${fmtTime(u.start)}–${fmtTime(u.end)}（${pct(u.coverage)}）`).join('、') + (selected.unresolved.length > 6 ? ' …' : ''),
              ) : null,
              h('div', { className: 'ss-note', style: { marginTop: 8 } },
                renders.length
                  ? `已缓存 ${renders.length} 个翻唱版本，点「试听」或播放条右侧的下拉框可以切换。`
                  : '每个方案生成后都会单独缓存，之后可以直接试听对比。',
              ),
              h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 } },
                h('button', {
                  className: 'ss-btn primary', onClick: render,
                  disabled: !envReady || !selected || jobBusy || (backend === 'soulx' && (!soulxReady || !promptReady)),
                }, '用这个方案生成'),
                renderForRow(selected) ? h('span', { className: 'ss-tag good' }, '已缓存') : null,
                h('button', { className: 'ss-btn ghost', onClick: plan, disabled: !envReady || jobBusy }, '重新规划'),
              ),
              job ? h(JobProgress, { job, onCancel: cancel }) : null,
              job?.error ? h('div', { className: 'ss-warn' }, job.error) : null,
            ),
            h('div', null,
              h(Card, { title: '当前方案', icon: ICON.check },
                selected ? h(React.Fragment, null,
                  h('div', { className: 'ss-metric', style: { marginBottom: 10 } },
                    h('div', { className: 'k' }, '舒适区覆盖'),
                    h('div', { className: 'v', style: { color: selected.coverage.comfort >= (plans.target ?? 0.95) ? 'var(--dsw-alias-state-success-primary)' : undefined } }, pct(selected.coverage.comfort)),
                    h('div', { className: 'h' }, `${selected.label} · 变调 ${selected.changes} 次`),
                  ),
                  h('div', { className: 'ss-note' }, `未解决乐句：${selected.unresolved?.length || 0}`),
                  backend === 'soulx' ? h('div', { className: 'ss-note', style: { marginTop: 8 } },
                    'SoulX 零样本：用 promptWav 参考，首次加载 1–2 分钟。',
                  ) : null,
                ) : h('div', { className: 'ss-note' }, '还没有选中方案。'),
              ),
            ),
          ),
        )
      }

      const renderEnv = () => {
        const manifest = envManifest || []
        const missingFiles = manifest.filter((e) => !e.present)
        const missingBytes = missingFiles.reduce((n, e) => n + (Number(e.size) || 0), 0)
        const downloadMinutes = missingBytes > 0 ? Math.max(1, Math.round(missingBytes / (5 * 1024 * 1024) / 60)) : 0
        const readyFiles = manifest.filter((e) => e.present)
        const resumable = missingFiles.filter((e) => Number(e.partial) > 0).length
        const statusTag = h('span', { className: 'ss-tag ' + (state ? (envReady ? 'good' : 'warn') : '') },
          state ? (envReady ? '全部就绪' : `还缺 ${deps.missing?.length || 0} 项`) : '检查中…')
        const rvcLoaded = Boolean(state?.workers?.rvc?.started)
        const soulxLoaded = Boolean(state?.workers?.soulx?.started)
        const failedText = setupFailed ? String(job?.error || '') : ''
        const failedEntry = failedText
          ? manifest.find((e) => !e.present && ((e.urls || []).some((u) => failedText.includes(u)) || failedText.includes(e.label)))
          : null
        const orderedMissing = failedEntry
          ? [failedEntry, ...missingFiles.filter((e) => e.id !== failedEntry.id)]
          : missingFiles
        const fileRow = (entry, failed) => h(EnvFileRow, {
          key: entry.id, entry, failed,
          uploading: envUpload, onUpload: uploadEnvFile, onCopy: copyText,
        })
        return h(React.Fragment, null,
          h(PageIntro, {
            icon: ICON.env,
            title: '环境安装',
            desc: '首次使用直接点「一键安装」即可；依赖清单默认收起，下载失败时会展开对应文件的下载链接和放置框。',
            right: statusTag,
          }),

          h(Card, {
            title: '一键安装',
            icon: ICON.download,
            desc: '首次约 5–15 分钟，取决于网速和是否已有缓存；安装路径由插件自动管理，中途退出可以再点一次继续。',
            right: statusTag,
          },
            h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
              h('button', { className: 'ss-btn primary', onClick: startSetup, disabled: jobBusy },
                setupBusy ? '安装中…' : (envReady ? '重新检查 / 补装' : '一键安装 / 继续安装')),
              h('button', { className: 'ss-btn ghost', onClick: checkEnv, disabled: jobBusy || setupBusy }, '重新检查环境'),
            ),
            h('div', { className: 'ss-help', style: { marginTop: 8 } },
              missingFiles.length
                ? `还有 ${missingFiles.length} 个文件待下载${missingBytes ? `（${fmtMB(missingBytes)}，按 5 MB/s 约 ${downloadMinutes} 分钟）` : ''}；` : (envReady ? '下载项都已就位；' : ''),
              missingBytes ? '另需依赖安装时间；' : '',
              resumable ? `其中 ${resumable} 个已有 .part 断点；` : '',
              '已完成的步骤会跳过，下载使用 .part 文件断点续传，中断后重新点「一键安装」即可继续。'),
            job && job.type === 'setup' ? h(JobProgress, { job, onCancel: cancel }) : null,
            job?.type === 'setup' && job.error ? h('div', { className: 'ss-warn' }, job.error) : null,
            state && !envReady ? h('div', { className: 'ss-warn', style: { marginTop: 8 } },
              `环境还缺 ${deps.missing?.length || 0} 项：${deps.missing.map((x) => x.label).join('、')}`) : null,
          ),

          h('div', { className: 'ss-grid ss-main-side', style: { marginTop: 14 } },
            h(Card, {
              title: '依赖清单',
              icon: ICON.env,
              desc: '必选项全部就绪后，分析和生成才会开放；默认收起，不影响一键安装。',
              right: statusTag,
            },
              h('details', { className: 'ss-settings-section' },
                h('summary', null,
                  h('span', { className: 'ss-settings-summary' },
                    h('span', { className: 'ss-settings-title' }, `全部依赖（${(deps.items || []).length} 项）`),
                    h('span', { className: 'ss-settings-desc' },
                      state ? (envReady ? '全部就绪' : `还缺 ${deps.missing?.length || 0} 项，点开查看`) : '检查中…'),
                  ),
                  h('span', { className: 'ss-settings-chevron' }, h(NavIcon, { d: ICON.chevron, size: 14 })),
                ),
                h('div', { className: 'ss-env-grid' },
                  (deps.items || []).map((item) => h('div', { key: item.id, className: 'ss-env-item' },
                    h('i', { className: 'ss-dot ' + (item.ok ? 'ok' : item.required === false ? 'opt' : '') }),
                    h('div', { style: { minWidth: 0 } },
                      h('div', { className: 'ss-env-name' }, item.label),
                      h('div', { className: 'ss-env-detail' },
                        item.detail || (item.ok ? '已就绪' : '未就绪'),
                        !item.ok && item.required === false ? '（可选，不影响分析/生成）' : ''),
                    ),
                  )),
                  !(deps.items || []).length ? h('div', { className: 'ss-note' }, '正在检查环境…') : null,
                ),
              ),
            ),
            h(Card, { title: '设备与常驻', icon: ICON.settings },
              h('div', { className: 'ss-device-grid' },
                h('div', { className: 'ss-device' },
                  h('div', { className: 'k' }, 'RVC 推理设备'),
                  h('div', { className: 'v' }, state?.deps?.devices?.rvc?.device === 'cuda' ? `CUDA${state.deps.devices.rvc.gpu ? ' · ' + state.deps.devices.rvc.gpu : ''}` : state?.deps?.devices?.rvc?.device === 'mps' ? 'Apple GPU（mps）' : 'CPU'),
                  h('div', { className: 'h' }, rvcLoaded ? 'Worker 已加载' : 'Worker 未加载'),
                  h(DeviceActions, {
                    backend: 'rvc', warmup: warmups.rvc, loaded: rvcLoaded,
                    busy: Boolean(jobBusy || warmupBusy), unloading: Boolean(unloading.rvc),
                    onPreload: () => preload('rvc'),
                    onStop: () => stopWarmup('rvc'),
                    onUnload: () => unloadModel('rvc'),
                  }),
                ),
                h('div', { className: 'ss-device' },
                  h('div', { className: 'k' }, 'SoulX 推理设备'),
                  h('div', { className: 'v' }, state?.deps?.devices?.soulx?.device === 'cuda' ? `CUDA${state.deps.devices.soulx.gpu ? ' · ' + state.deps.devices.soulx.gpu : ''}` : state?.deps?.devices?.soulx?.device === 'mps' ? 'Apple GPU（mps）' : 'CPU'),
                  h('div', { className: 'h' }, soulxLoaded ? 'Worker 已加载' : 'Worker 未加载'),
                  h(DeviceActions, {
                    backend: 'soulx', warmup: warmups.soulx, loaded: soulxLoaded,
                    busy: Boolean(jobBusy || warmupBusy), unloading: Boolean(unloading.soulx),
                    onPreload: () => preload('soulx'),
                    onStop: () => stopWarmup('soulx'),
                    onUnload: () => unloadModel('soulx'),
                  }),
                ),
                h('div', { className: 'ss-device' },
                  h('div', { className: 'k' }, '音色模型'),
                  h('div', { className: 'v' }, `${voices.length} 个`),
                  h('div', { className: 'h' }, voices.filter((v) => v.calibrated).length + ' 个已校准'),
                ),
              ),
            ),
          ),

          h(Card, {
            title: '手动下载 / 离线安装',
            icon: ICON.download,
            desc: '网络不稳时自己下载：把文件拖进对应框，插件会直接放进目标路径。',
            right: h('button', { className: 'ss-btn sm ghost', onClick: () => loadManifest(), disabled: envManifestLoading },
              envManifestLoading ? '读取中…' : '刷新清单'),
            style: { marginTop: 14 },
          },
            setupFailed ? h('div', { className: 'ss-warn' },
              h('div', null, `一键安装中断：${failedText.slice(-300) || '未知错误'}`),
              h('div', { className: 'ss-help', style: { marginTop: 4 } },
                '下载部分文件失败时，可以按下面的下载线路自己下载；速度慢可以在「设置 → 下载」里填代理。'),
              h('div', { style: { marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' } },
                h('button', { className: 'ss-btn sm', onClick: startSetup, disabled: jobBusy }, '重试一键安装'),
                h('button', { className: 'ss-btn sm ghost', onClick: checkEnv, disabled: jobBusy }, '重新检查环境'),
              ),
            ) : null,
            envManifestError ? h('div', { className: 'ss-warn' }, envManifestError) : null,
            h('details', {
              ref: envManualRef,
              className: 'ss-settings-section',
              open: envManualOpen,
              onToggle: (e) => setEnvManualOpen(e.currentTarget.open),
            },
              h('summary', null,
                h('span', { className: 'ss-settings-summary' },
                  h('span', { className: 'ss-settings-title' }, `待下载文件（${missingFiles.length}）`),
                  h('span', { className: 'ss-settings-desc' },
                    missingFiles.length
                      ? `${missingBytes ? fmtMB(missingBytes) + ' · ' : ''}展开后可下载，或把已下载的文件拖进对应框`
                      : (manifest.length ? '当前都已就位' : '正在读取下载清单…')),
                ),
                h('span', { className: 'ss-settings-chevron' }, h(NavIcon, { d: ICON.chevron, size: 14 })),
              ),
              orderedMissing.length
                ? h('div', { className: 'ss-dl-list' }, orderedMissing.map((entry) => fileRow(entry, failedEntry?.id === entry.id)))
                : h('div', { className: 'ss-note' }, manifest.length ? '下载清单里的文件都已就位。' : '正在读取下载清单…'),
              readyFiles.length
                ? h('details', { className: 'ss-settings-section', style: { marginTop: 10 } },
                  h('summary', null,
                    h('span', { className: 'ss-settings-summary' },
                      h('span', { className: 'ss-settings-title' }, `已就位文件（${readyFiles.length}）`),
                      h('span', { className: 'ss-settings-desc' }, '展开可以复制路径或重新下载'),
                    ),
                    h('span', { className: 'ss-settings-chevron' }, h(NavIcon, { d: ICON.chevron, size: 14 })),
                  ),
                  h('div', { className: 'ss-dl-list' }, readyFiles.map((entry) => fileRow(entry, false))),
                )
                : null,
            ),
          ),
        )
      }

      const renderSettings = () => h(React.Fragment, null,
        h(PageIntro, {
          icon: ICON.settings,
          title: '设置',
          desc: '通用行为与下载代理；安装路径由插件自动管理。',
          right: h('span', { className: 'ss-tag' }, state ? (state.settings?.mode === 'existing' ? 'existing 模式' : 'managed 模式') : '读取中…'),
        }),
        h(Card, { title: '数据与位置', icon: ICON.info },
          h('div', { className: 'ss-kv', style: { marginTop: 0 } },
            h('span', { className: 'k' }, '插件数据目录'),
            h('span', { className: 'v' }, state?.dataDir || '—'),
            h('span', { className: 'k' }, '音色模型目录'),
            h('span', { className: 'v' }, state?.settings?.modelsDir || '—'),
          ),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 } },
            h('button', { className: 'ss-btn sm ghost', onClick: () => copyText(state?.dataDir || '', '数据目录') }, '复制数据目录'),
            h('button', { className: 'ss-btn sm ghost', onClick: () => go('env') }, '环境安装'),
            h('button', { className: 'ss-btn sm ghost', onClick: () => go('train') }, 'RVC训练'),
            h('button', { className: 'ss-btn sm ghost', onClick: () => goStudio('songs') }, '制作台'),
          ),
        ),
        h(SettingsPanel, {
          state, draft: settingsDraft, setDraft: setSettingsDraft, onSaved: loadState, toast: notify,
          groups: SETTING_GROUPS.filter((g) => g.page === 'settings'),
          title: '通用设置',
          desc: '只保留全局行为；训练和制作参数在对应页面。',
        }),
      )

      const STUDIO_TABS = [['songs', '歌曲库'], ['timeline', '音高时间轴'], ['plans', '八度方案']]
      const renderStudioPage = () => h(React.Fragment, null,
        h('div', { className: 'ss-tabs', role: 'tablist', 'aria-label': '制作台视图' },
          STUDIO_TABS.map(([id, label]) => h('button', {
            key: id, type: 'button', role: 'tab',
            'aria-selected': studioView === id,
            className: 'ss-tab' + (studioView === id ? ' on' : ''),
            onClick: () => setStudioView(id),
          }, label)),
        ),
        studioView === 'timeline' ? renderTimeline() : studioView === 'plans' ? renderPlans() : renderStudio(),
      )

      const body = page === 'env'
        ? renderEnv()
        : page === 'train'
          ? renderTrain()
          : page === 'studio'
            ? renderStudioPage()
            : renderSettings()

      return h('div', { className: 'ss-page', ref: pageElRef },
        h('style', null, cssText),
        h('div', { className: 'ss-inner' },
          h('div', { className: 'ss-hero' },
            h('span', { className: 'ss-hero-mark' }, h(WhaleIcon, { size: 32 })),
            h('div', { className: 'ss-hero-body' },
              h('div', { className: 'ss-eyebrow' }, 'Virtual Singer · Singing Studio'),
              h('h1', { className: 'ss-title' }, '唱歌工作室'),
              h('p', { className: 'ss-sub' }, '上传歌曲 → 分析音高 → 自动定八度 → 生成翻唱。只改人声，伴奏不动。'),
              h('div', { className: 'ss-hero-tags' },
                h('span', { className: 'ss-chip' }, h('i', { className: 'ss-mini-dot' + (song ? ' ok' : '') }), '歌曲', h('b', null, song ? song.name : '未选择')),
                h('span', { className: 'ss-chip' }, h('i', { className: 'ss-mini-dot' + (voice ? ' ok' : '') }), '音色', h('b', null, voice ? voice.label : '未选择')),
                h('span', { className: 'ss-chip' }, h('i', { className: 'ss-mini-dot' + (backend === 'rvc' ? ' ok' : '') }), '后端', h('b', null, backend === 'soulx' ? 'SoulX-SVC' : 'RVC')),
                h('span', { className: 'ss-chip' }, h('i', { className: 'ss-mini-dot' + (audioUrl ? ' ok' : '') }), '成品', h('b', null, audioUrl ? '可试听' : '未生成')),
              ),
            ),
            h('div', { className: 'ss-hero-side' },
              h('div', { className: 'ss-pills' },
                state ? [
                  h('span', { key: 'env', className: 'ss-pill ' + (envReady ? 'ok' : 'bad') }, envReady ? '环境已就绪' : `环境缺 ${deps.missing?.length || 0} 项`),
                  h('span', { key: 'rvc', className: 'ss-pill ' + (state.settings?.checks?.rvc ? 'ok' : 'bad') }, state.settings?.checks?.rvc ? 'RVC 就绪' : 'RVC 缺失'),
                  h('span', { key: 'sep', className: 'ss-pill ' + (state.settings?.checks?.separator && state.settings?.checks?.separatorModels ? 'ok' : 'bad') }, state.settings?.checks?.separator && state.settings?.checks?.separatorModels ? '分离器就绪' : '分离器未配置'),
                  h('span', { key: 'soulx', className: 'ss-pill ' + (soulxReady ? 'ok' : 'bad') }, soulxReady ? 'SoulX 就绪' : 'SoulX 未安装'),
                ] : h('span', { className: 'ss-pill' }, '正在读取状态…'),
              ),
              h('span', { className: 'ss-version' }, `v${state?.version || '0.1.0'}`),
            ),
          ),
          h('nav', { className: 'ss-nav', 'aria-label': '唱歌工作室页面' },
            PAGES.map((p) => h('button', {
              key: p.id, type: 'button',
              className: 'ss-nav-card' + (page === p.id ? ' on' : ''),
              'aria-current': page === p.id ? 'page' : undefined,
              onClick: () => go(p.id),
            },
              h('span', { className: 'ss-nav-icon' }, h(NavIcon, { d: p.icon, size: 18 })),
              h('span', { className: 'ss-nav-copy' },
                h('span', { className: 'ss-nav-label' }, p.label),
                h('span', { className: 'ss-nav-hint' }, navHint(p.id)),
              ),
            )),
          ),
          playableUrl ? h('div', {
            className: 'ss-player',
            style: page === 'studio' ? undefined : { display: 'none' },
            'aria-hidden': page === 'studio' ? undefined : 'true',
          },
            h('div', { className: 'ss-player-side' },
              h('span', { className: 'ss-player-label' },
                h(NavIcon, { d: ICON.speaker, size: 16 }),
                audioSource === 'cover' && coverUrl
                  ? (selectedRender ? `翻唱 · ${renderLabel(selectedRender)}` : '翻唱试听')
                  : '原曲试听'),
              sourceToggle(),
              renders.length ? h('select', {
                className: 'ss-select ss-render-pick',
                value: renderId || (audioSource === 'cover' ? (selectedRender?.id || '') : ''),
                title: '选择要试听的翻唱版本',
                onChange: (e) => {
                  const hit = renders.find((x) => x.id === e.target.value)
                  if (hit) selectRender(hit)
                },
              },
                !renderId && audioSource !== 'cover' ? h('option', { value: '' }, `翻唱版本（${renders.length}）`) : null,
                renders.map((r) => h('option', { key: r.id, value: r.id }, renderLabel(r, true))),
              ) : null,
            ),
            h('audio', {
              ref: audioRef, key: 'audio-' + audioEpoch, src: playableUrl, preload: 'auto',
              onTimeUpdate: onAudioTime,
              onLoadedMetadata: onAudioMeta,
              onDurationChange: onAudioDuration,
              onCanPlay: onAudioCanPlay,
              onWaiting: onAudioWaiting,
              onPlaying: clearStallWatch,
              onSeeked: clearStallWatch,
              onPlay: () => setIsPlaying(true),
              onPause: () => setIsPlaying(false),
              onEnded: () => { setIsPlaying(false); wantPlayRef.current = false; stopAtRef.current = null; pendingSeekRef.current = null },
              onError: onAudioError,
            }),
            h('div', { className: 'ss-player-body' },
              h('button', {
                type: 'button', className: 'ss-play-btn',
                'aria-label': isPlaying ? '暂停' : '播放', title: isPlaying ? '暂停' : '播放',
                onClick: togglePlay,
              }, h('svg', { viewBox: '0 0 24 24', width: 14, height: 14, fill: 'currentColor', 'aria-hidden': true },
                h('path', { d: isPlaying ? 'M7 5h4v14H7zM13 5h4v14h-4z' : 'M8 5v14l11-7z' }))),
              h('span', { className: 'ss-player-time' }, fmtTime(playhead)),
              h(SeekBar, {
                value: playhead,
                max: Math.max(1, totalDuration || 0),
                onSeek: seekTo,
                label: '播放进度',
              }),
              h('span', { className: 'ss-player-time' }, fmtTime(totalDuration || 0)),
            ),
            h('div', { className: 'ss-player-actions' },
              coverMixUrl || coverUrl ? h('a', { className: 'ss-btn sm', href: coverMixUrl || coverUrl, download: 'cover.mp3' }, h(NavIcon, { d: ICON.download, size: 14 }), '下载成品') : null,
              analysis?.songId ? h('a', { className: 'ss-btn sm ghost', href: `${API}/audio?kind=vocals&id=${analysis.songId}`, download: 'vocals.wav' }, '下载人声') : null,
            ),
            audioNote ? h('div', { className: 'ss-player-note' },
              h(NavIcon, { d: ICON.alert, size: 12 }),
              h('span', null, audioNote),
              h('button', {
                type: 'button', className: 'ss-btn sm ghost',
                onClick: () => restartAudio('手动重载', playhead),
              }, '重载音频'),
            ) : null,
          ) : null,
          h(PageBoundary, { key: page, onHome: () => goStudio('songs') }, body),
        ),
        h('input', {
          ref: fileRef, type: 'file', accept: 'audio/*', style: { display: 'none' },
          onChange: (e) => { const f = e.target.files?.[0]; e.target.value = ''; upload(f) },
        }),
        toast ? h('div', { className: 'ss-toast ' + (toast.kind === 'bad' ? 'bad' : ''), role: 'status', 'aria-live': 'polite' }, toast.text) : null,
      )
    }

    function WhaleIcon({ size = 24 }) {
      return h('svg', { viewBox: '0 0 32 32', width: size, height: size, 'aria-hidden': true },
        h('path', { d: 'M5 18c3-7 10-11 16-9 4 1.4 6 4.5 6 8 0 5-4 9-9 9H9a4 4 0 0 1-4-4v-4z', fill: 'currentColor', opacity: .9 }),
        h('circle', { cx: 21, cy: 14, r: 1.6, fill: 'var(--dsw-alias-bg-base)' }),
        h('path', { d: 'M16 8v5M13 10.5h6', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round' }),
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (!slots) return
      slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, StudioPage))
      slots.inject('sidebar.panellist', () => slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: () => '唱歌' }, WhaleIcon))
    }

    return { inject: ['slots'], apply }
  },
})

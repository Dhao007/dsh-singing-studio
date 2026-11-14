// 八度规划：候选八度由音色模型 profile + 歌曲 F0 共同决定。
// 三层互斥：原曲 0 → 全局八度 → 分段八度 → 乐句八度；每层都从原曲重新选绝对八度，不叠加。

const OCT = 12;

function pow2(x) {
  return Math.pow(2, x / OCT);
}

function clampPitchShift(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-12, Math.min(12, Math.round(n)));
}

function frameShiftArray(analysis, shifts) {
  const n = analysis.f0.length;
  const arr = new Int16Array(n);
  for (const s of shifts) {
    const a = Math.max(0, s.from | 0);
    const b = Math.min(n, s.to | 0);
    arr.fill(s.semitones | 0, a, b);
  }
  return arr;
}

function coverageOf(f0, rms, shift, lo, hi) {
  let num = 0;
  let den = 0;
  for (let i = 0; i < f0.length; i++) {
    const f = f0[i];
    if (!(f > 0)) continue;
    const w = Math.max(rms[i] || 0, 1e-6);
    den += w;
    const g = f * pow2(shift);
    if (g >= lo && g <= hi) num += w;
  }
  return den > 0 ? num / den : 0;
}

function coveragePlan(analysis, shiftArr, lo, hi) {
  let num = 0;
  let den = 0;
  for (let i = 0; i < analysis.f0.length; i++) {
    const f = analysis.f0[i];
    if (!(f > 0)) continue;
    const w = Math.max(analysis.rms[i] || 0, 1e-6);
    den += w;
    const g = f * pow2(shiftArr[i]);
    if (g >= lo && g <= hi) num += w;
  }
  return den > 0 ? num / den : 0;
}

function segmentRangeCost(analysis, seg, shift, profile) {
  const loC = profile.p5;
  const hiC = profile.p95;
  const loH = profile.p1;
  const hiH = profile.p99;
  const f0 = analysis.f0;
  const rms = analysis.rms;
  let sum = 0;
  let wsum = 0;
  const a = Math.max(0, seg.from | 0);
  const b = Math.min(f0.length, seg.to | 0);
  for (let i = a; i < b; i++) {
    const f = f0[i];
    if (!(f > 0)) continue;
    const w = Math.max(rms[i] || 0, 1e-6);
    const g = f * pow2(shift);
    let excess = 0;
    if (g > hiC) excess = OCT * Math.log2(g / hiC);
    else if (g < loC) excess = OCT * Math.log2(loC / g);
    let hard = 0;
    if (g > hiH) hard = OCT * Math.log2(g / hiH);
    else if (g < loH) hard = OCT * Math.log2(loH / g);
    sum += w * (excess * excess + 4 * hard * hard);
    wsum += w;
  }
  return wsum > 0 ? sum / wsum : 0;
}

function buildOctaveCandidates(analysis, profile, opts) {
  const maxOct = Math.max(0, Math.min(3, opts.maxOctaves ?? 2));
  const baseShift = clampPitchShift(opts.pitchShift ?? 0);
  const target = opts.targetCoverage ?? 0.95;
  const loC = profile.p5;
  const hiC = profile.p95;
  const loH = profile.p1;
  const hiH = profile.p99;
  const comfortOf = (s) => coverageOf(analysis.f0, analysis.rms, s, loC, hiC);
  const hardOf = (s) => coverageOf(analysis.f0, analysis.rms, s, loH, hiH);
  const list = [];
  for (let k = -maxOct; k <= maxOct; k++) {
    const s = baseShift + k * OCT;
    const comfort = comfortOf(s);
    const hard = hardOf(s);
    // 只有能和模型极限区产生实际重叠的八度才值得作为候选；用户指定的整体变调始终保留。
    if (s !== baseShift && hard < 0.08) continue;
    list.push({ semitones: s, octaves: k, comfort, hard });
  }
  if (!list.some((x) => x.semitones === baseShift)) {
    list.push({ semitones: baseShift, octaves: 0, comfort: comfortOf(baseShift), hard: hardOf(baseShift) });
  }
  list.sort((a, b) => (b.comfort - a.comfort) || (Math.abs(a.semitones - baseShift) - Math.abs(b.semitones - baseShift)));
  const keep = list.slice(0, Math.max(2, Math.min(6, opts.maxCandidates ?? 4)));
  if (!keep.some((x) => x.semitones === baseShift)) {
    const base = list.find((x) => x.semitones === baseShift);
    if (base) keep.push(base);
  }
  keep.sort((a, b) => a.semitones - b.semitones);
  // 目标只是提示，不在这里裁剪；保留数据给 UI 显示。
  for (const x of keep) x.meets = x.comfort >= target;
  return keep;
}

function jumpCost(prev, next, gap, opts) {
  if (prev === next) return 0;
  const d = Math.abs(next - prev) / OCT;
  let c = 3.0 * d * d;
  if (prev * next < 0 && d >= 2) c += 12;
  if (gap < (opts.boundaryMinGap ?? 0.12)) c += 100;
  else if (gap < 0.25) c += 2;
  return c;
}

function viterbi(analysis, segments, candidates, profile, opts, level) {
  const N = segments.length;
  const M = candidates.length;
  if (!N || !M) return null;
  const change = opts.changePenalty ?? 4;
  const dp = Array.from({ length: N }, () => new Float64Array(M).fill(Infinity));
  const back = Array.from({ length: N }, () => new Int16Array(M).fill(-1));
  for (let j = 0; j < M; j++) {
    dp[0][j] = segmentRangeCost(analysis, segments[0], candidates[j].semitones, profile)
      + (candidates[j].semitones !== 0 ? change : 0);
  }
  for (let i = 1; i < N; i++) {
    const gap = Math.max(0, segments[i].start - segments[i - 1].end);
    for (let j = 0; j < M; j++) {
      const sj = candidates[j].semitones;
      const own = segmentRangeCost(analysis, segments[i], sj, profile)
        + (sj !== 0 ? change : 0);
      let best = Infinity;
      let bestK = -1;
      for (let k = 0; k < M; k++) {
        const sk = candidates[k].semitones;
        let c = dp[i - 1][k] + jumpCost(sk, sj, gap, opts) + own;
        // 乐句级在同一个 section 内部额外惩罚，优先在段边界变调。
        if (level === 'phrase' && sk !== sj && segments[i].section === segments[i - 1].section) {
          c += opts.intraSectionPenalty ?? 1.5;
        }
        if (c < best) {
          best = c;
          bestK = k;
        }
      }
      dp[i][j] = best;
      back[i][j] = bestK;
    }
  }
  let bestJ = 0;
  for (let j = 1; j < M; j++) if (dp[N - 1][j] < dp[N - 1][bestJ]) bestJ = j;
  const picks = new Array(N);
  let j = bestJ;
  for (let i = N - 1; i >= 0; i--) {
    picks[i] = candidates[j].semitones;
    j = back[i][j];
  }
  return picks;
}

function shiftsFromPicks(segments, picks) {
  return segments.map((seg, i) => ({
    start: seg.start,
    end: seg.end,
    from: seg.from,
    to: seg.to,
    semitones: picks[i],
  }));
}

function coverageOfShifts(analysis, shifts, profile) {
  const arr = frameShiftArray(analysis, shifts);
  return {
    comfort: coveragePlan(analysis, arr, profile.p5, profile.p95),
    hard: coveragePlan(analysis, arr, profile.p1, profile.p99),
  };
}

function changesOf(shifts) {
  let n = 0;
  for (let i = 1; i < shifts.length; i++) if (shifts[i].semitones !== shifts[i - 1].semitones) n++;
  return n;
}

function withSectionIds(analysis, phrases, sections) {
  const out = phrases.map((p, i) => ({ ...p, phrase: i, section: -1 }));
  for (let si = 0; si < sections.length; si++) {
    const s = sections[si];
    for (const p of out) {
      if (p.start >= s.start - 1e-6 && p.end <= s.end + 1e-6) p.section = si;
    }
  }
  for (const p of out) if (p.section < 0) p.section = 0;
  return out;
}

function unresolvedOf(analysis, shifts, profile, threshold = 0.5) {
  const out = [];
  for (const s of shifts) {
    let num = 0;
    let den = 0;
    for (let i = Math.max(0, s.from); i < Math.min(analysis.f0.length, s.to); i++) {
      const f = analysis.f0[i];
      if (!(f > 0)) continue;
      const w = Math.max(analysis.rms[i] || 0, 1e-6);
      den += w;
      const g = f * pow2(s.semitones);
      if (g >= profile.p5 && g <= profile.p95) num += w;
    }
    const cov = den > 0 ? num / den : 1;
    if (cov < threshold) out.push({ start: s.start, end: s.end, coverage: cov, semitones: s.semitones });
  }
  return out;
}

function planForShift(analysis, profile, opts, baseShift, autoPitch) {
  const target = opts.targetCoverage;
  const candidates = buildOctaveCandidates(analysis, profile, { ...opts, pitchShift: baseShift });
  const phrases = withSectionIds(analysis, analysis.phrases || [], analysis.sections || []);
  const sections = (analysis.sections || []).map((s, i) => ({ ...s, section: i, phrase: i }));

  const table = [];
  const seen = new Set();

  const add = (id, label, level, shifts) => {
    const cov = coverageOfShifts(analysis, shifts, profile);
    const key = `${level}:${shifts.map((s) => s.semitones).join(',')}`;
    if (seen.has(key)) return;
    seen.add(key);
    table.push({
      id,
      label,
      level,
      shifts,
      coverage: cov,
      changes: changesOf(shifts),
      unresolved: unresolvedOf(analysis, shifts, profile),
    });
  };

  // 整体变调基线：没设置半音偏移时就是原曲 0；设置后作为「整体 +N」参与比较。
  const baseRowId = baseShift === 0 ? 'none' : 'pitch';
  add(baseRowId, baseShift === 0 ? '原曲 0' : `整体 ${baseShift > 0 ? '+' : ''}${baseShift}`,
    baseShift === 0 ? 'none' : 'pitch',
    phrases.map((p) => ({ start: p.start, end: p.end, from: p.from, to: p.to, semitones: baseShift })));
  if (autoPitch) {
    const baseRow = table.find((r) => r.id === baseRowId);
    if (baseRow) baseRow.autoPitch = true;
  }

  // 全局：每个候选八度都列出来，便于对比；整体变调基线不重复。
  for (const c of candidates) {
    if (c.semitones === baseShift) continue;
    add(`global-${c.semitones}`, `全局 ${c.semitones > 0 ? '+' : ''}${c.semitones}`, 'global',
      phrases.map((p) => ({ start: p.start, end: p.end, from: p.from, to: p.to, semitones: c.semitones })));
  }

  // 分段
  if (sections.length) {
    const picks = viterbi(analysis, sections, candidates, profile, opts, 'section');
    if (picks) {
      const secShifts = shiftsFromPicks(sections, picks);
      const phraseShifts = phrases.map((p) => {
        const sec = secShifts[p.section] || secShifts[0];
        return { start: p.start, end: p.end, from: p.from, to: p.to, semitones: sec.semitones };
      });
      add('section', '分段', 'section', phraseShifts);
    }
  }

  // 乐句
  if (phrases.length) {
    const picks = viterbi(analysis, phrases, candidates, profile, opts, 'phrase');
    if (picks) add('phrase', '乐句', 'phrase', shiftsFromPicks(phrases, picks));
  }

  const meets = (row) => row.coverage.comfort >= target;
  const priority = ['none', 'pitch', 'global', 'section', 'phrase'];
  let selected = table.find((r) => (r.id === 'none' || r.id === 'pitch') && meets(r)) || null;
  if (!selected) {
    for (const level of priority) {
      const rows = table.filter((r) => r.level === level && meets(r));
      if (rows.length) {
        rows.sort((a, b) => (a.changes - b.changes) || (b.coverage.comfort - a.coverage.comfort));
        selected = rows[0];
        break;
      }
    }
  }
  if (!selected) {
    selected = table.slice().sort((a, b) => (b.coverage.comfort - a.coverage.comfort) || (a.changes - b.changes))[0];
  }

  return {
    target,
    pitchShift: baseShift,
    autoPitch,
    candidates,
    table,
    selectedId: selected.id,
    selected,
    phraseCount: phrases.length,
    sectionCount: sections.length,
  };
}

// 自动搜索时比较最终推荐的方案：先覆盖率，再极限覆盖、变调次数、未解决乐句和偏移量。
function compareAuto(a, b) {
  const A = a.selected || {};
  const B = b.selected || {};
  const ac = A.coverage?.comfort ?? 0;
  const bc = B.coverage?.comfort ?? 0;
  if (bc !== ac) return bc - ac;
  const ah = A.coverage?.hard ?? 0;
  const bh = B.coverage?.hard ?? 0;
  if (bh !== ah) return bh - ah;
  const ach = A.changes ?? 0;
  const bch = B.changes ?? 0;
  if (ach !== bch) return ach - bch;
  const au = A.unresolved?.length || 0;
  const bu = B.unresolved?.length || 0;
  if (au !== bu) return au - bu;
  // 最终方案打平时，优先整体覆盖率更高的基准，避免在 ±N 之间随意选一个。
  const abase = a.table.find((r) => r.id === 'pitch' || r.id === 'none')?.coverage?.comfort ?? 0;
  const bbase = b.table.find((r) => r.id === 'pitch' || r.id === 'none')?.coverage?.comfort ?? 0;
  if (bbase !== abase) return bbase - abase;
  const abaseHard = a.table.find((r) => r.id === 'pitch' || r.id === 'none')?.coverage?.hard ?? 0;
  const bbaseHard = b.table.find((r) => r.id === 'pitch' || r.id === 'none')?.coverage?.hard ?? 0;
  if (bbaseHard !== abaseHard) return bbaseHard - abaseHard;
  return Math.abs(a.pitchShift) - Math.abs(b.pitchShift);
}

export function buildPlans(analysis, profile, options = {}) {
  const opts = {
    targetCoverage: 0.95,
    maxOctaves: 2,
    maxCandidates: 4,
    pitchShift: 'auto',
    changePenalty: 4,
    boundaryMinGap: 0.12,
    intraSectionPenalty: 1.5,
    ...options,
  };
  const requested = opts.pitchShift;
  // 自动模式遍历 -12～+12 半音，对每个偏移生成完整方案，再按最终推荐方案的覆盖率取最优。
  if (requested === 'auto' || requested === true || requested == null) {
    let best = null;
    for (let shift = -12; shift <= 12; shift++) {
      const result = planForShift(analysis, profile, opts, shift, true);
      if (!best || compareAuto(result, best) < 0) best = result;
    }
    return best;
  }
  return planForShift(analysis, profile, opts, clampPitchShift(requested), false);
}

'use strict';

/**
 * 起点偏差拆解（只读）：
 * 仅基于「本次冻结计划」（rehearsal.cues / rehearsal.schedule）与「当前登记」
 * （rehearsal.records）计算，不读取也不修改原提示单，不持久化任何内容。
 *
 * 对每条已开始（已有实际开始 A）的提示，取冻结计划开始 P：
 * - 起点约束 O：
 *     fixed：固定秒数 fixedAt；
 *     after：前置提示的【实际】结束 + 延迟秒数（前置未登记实际结束则该约束不可用）。
 * - 通道约束 C：同通道【其他】提示中，实际结束不晚于 A（actualEnd <= A，首尾相接计入）
 *   的实际结束最大值；没有则 0。A 之后才结束的提示不计为当时阻塞。
 * - R = max(O, C)，列出所有达到 R 的约束（起点 / 通道，可能并列）及相关提示。
 * - 分解：约束位移 R-P（可为负）+ 额外等待 A-R = 总偏差 A-P。
 * 未开始提示标记为「未分析」。
 */

const { round } = require('./scheduler');

const EPS = 1e-9; // 与登记校验 / 冲突检测一致的浮点容差

// 所有登记秒数均已 round 到 3 位小数；把秒数换算为「千分之一秒整数」，
// 使分解等式 (R-P)+(A-R)=(A-P) 在整数运算下严格成立（规避浮点尾差）。
const K = 1000;
const toK = (n) => Math.round(n * K);

function recOf(rehearsal, cueId) {
  const rec = rehearsal.records[cueId];
  if (!rec) return { actualStart: null, actualEnd: null };
  return {
    actualStart: rec.actualStart === undefined ? null : rec.actualStart,
    actualEnd: rec.actualEnd === undefined ? null : rec.actualEnd,
  };
}

/**
 * 计算单条提示的起点约束 O。
 * 返回 { origin }：
 *   fixed 且可用：{ type:'fixed', value, available:true, fixedAt, relatedCue*:null }
 *   after 且可用：{ type:'after', value: predActualEnd+delay, available:true,
 *                   relatedCueId/Name, relatedActualEnd, delayAfter }
 *   after 不可用：{ ..., value:null, available:false, relatedActualEnd:null }
 */
function originConstraint(rehearsal, cue) {
  if (cue.startType === 'fixed') {
    const fixedAt = round(cue.fixedAt);
    return {
      type: 'fixed',
      value: fixedAt,
      available: true,
      fixedAt,
      delayAfter: null,
      relatedCueId: null,
      relatedCueName: null,
      relatedActualEnd: null,
    };
  }

  const delayAfter = round(cue.delayAfter);
  const pred = rehearsal.cues.find((c) => c.id === cue.afterCueId) || null;
  const predRec = recOf(rehearsal, cue.afterCueId);
  if (predRec.actualEnd === null) {
    // 正常登记流程不会出现（登记开始时前置必须已实际结束）；兼容手工改动的记录文件
    return {
      type: 'after',
      value: null,
      available: false,
      fixedAt: null,
      delayAfter,
      relatedCueId: cue.afterCueId,
      relatedCueName: pred ? pred.name : null,
      relatedActualEnd: null,
    };
  }

  return {
    type: 'after',
    value: round(predRec.actualEnd + delayAfter),
    available: true,
    fixedAt: null,
    delayAfter,
    relatedCueId: cue.afterCueId,
    relatedCueName: pred ? pred.name : null,
    relatedActualEnd: predRec.actualEnd,
  };
}

/**
 * 通道约束 C：同通道其他提示中「实际结束 <= A」的最大值（没有则 0）。
 * 返回 { value, blockers }，blockers 按实际结束降序，达到最大值者 attainsMax=true。
 */
function channelConstraint(rehearsal, cue, at) {
  const blockers = [];
  for (const other of rehearsal.cues) {
    if (other.id === cue.id || other.channel !== cue.channel) continue;
    const r = recOf(rehearsal, other.id);
    // 仅统计已实际结束、且结束时刻不晚于 A 的其他提示（首尾相接计入；A 之后结束不计）
    if (r.actualEnd !== null && r.actualEnd <= at + EPS) {
      blockers.push({
        cueId: other.id,
        name: other.name,
        actualEnd: r.actualEnd,
        attainsMax: false,
      });
    }
  }
  blockers.sort(
    (a, b) => b.actualEnd - a.actualEnd || a.cueId.localeCompare(b.cueId)
  );

  const value = blockers.length ? blockers[0].actualEnd : 0;
  for (const b of blockers) {
    if (Math.abs(b.actualEnd - value) <= EPS) b.attainsMax = true;
  }
  return { value: round(value), blockers };
}

/**
 * 构建整次排练的起点偏差拆解。
 * 输出排序与 rehearsalView 一致（计划开始、计划结束、名称）。
 */
function buildStartBreakdown(rehearsal) {
  const schedMap = new Map(rehearsal.schedule.map((s) => [s.id, s]));

  const items = rehearsal.cues.map((cue) => {
    const t = schedMap.get(cue.id) || { start: null, end: null };
    const rec = recOf(rehearsal, cue.id);
    const status =
      rec.actualStart === null ? 'pending' : rec.actualEnd === null ? 'running' : 'done';

    const base = {
      cueId: cue.id,
      name: cue.name,
      channel: cue.channel,
      status,
      plannedStart: t.start,
      plannedEnd: t.end,
      actualStart: rec.actualStart,
      actualEnd: rec.actualEnd,
      analyzed: false,
    };

    // 未开始（或冻结计划缺时间，正常不会发生）一律不分析
    if (rec.actualStart === null || t.start === null) return base;

    const P = t.start;
    const A = rec.actualStart;

    const origin = originConstraint(rehearsal, cue);
    const channel = channelConstraint(rehearsal, cue, A);

    // R = 两者最大值；起点约束不可用时（前置缺实际结束）仅取通道约束
    const candidates = [];
    if (origin.available) candidates.push(origin.value);
    candidates.push(channel.value);
    const R = round(Math.max(...candidates));

    // 所有达到 R 的约束（含并列）
    const binding = [];
    if (origin.available && Math.abs(origin.value - R) <= EPS) binding.push('origin');
    if (Math.abs(channel.value - R) <= EPS) binding.push('channel');

    // 分解等式：约束位移 + 额外等待 = 总偏差（位移可为负，等待非负）。
    // 先在「千分之一秒整数」上运算保证代数正确，再统一 round 到 3 位小数；
    // 额外等待由 (总偏差 − 位移) 取等得到，使三个展示值在浮点上仍严格满足相加关系。
    const shiftK = toK(R) - toK(P); // R-P，可为负（前置实际早于计划时）
    const waitK = toK(A) - toK(R); // A-R，非负（R <= A）
    const totalK = shiftK + waitK; // 整数层面恒等于 A-P
    const constraintShift = round(shiftK / K);
    const totalDelta = round(totalK / K);
    const extraWait = round(totalDelta - constraintShift); // === round(A-R)

    return {
      ...base,
      analyzed: true,
      origin,
      channelConstraint: channel,
      readyAt: R,
      binding,
      constraintShift,
      extraWait,
      totalDelta,
    };
  });

  items.sort(
    (a, b) =>
      (a.plannedStart === null ? Infinity : a.plannedStart) -
        (b.plannedStart === null ? Infinity : b.plannedStart) ||
      (a.plannedEnd === null ? Infinity : a.plannedEnd) -
        (b.plannedEnd === null ? Infinity : b.plannedEnd) ||
      a.name.localeCompare(b.name)
  );

  const counts = { total: items.length, analyzed: 0, pending: 0, running: 0, done: 0 };
  for (const it of items) {
    counts[it.status] += 1;
    if (it.analyzed) counts.analyzed += 1;
  }

  return {
    rehearsalId: rehearsal.id,
    startedAt: rehearsal.startedAt,
    basis: {
      cuesVersion: rehearsal.cuesVersion,
      frozenCueCount: rehearsal.cues.length,
      recordCount: Object.keys(rehearsal.records).length,
    },
    items,
    counts,
  };
}

module.exports = { buildStartBreakdown };

'use strict';

/**
 * 起点偏差拆解（只读计算，不修改任何数据）：
 * 对本次排练中每条「已开始」（已登记实际开始）的提示，把实际开始相对计划开始的
 * 总偏差拆解为：
 *   总偏差（A − P） = 约束位移（R − P） + 额外等待（A − R）
 * 其中 P = 冻结计划开始，A = 登记的实际开始，R = 约束放行时刻，取两类约束的最大值：
 *   1) 起点约束：固定开始秒数；或前置提示的「实际结束 + 延迟秒数」；
 *   2) 通道约束：同通道「其他」提示中、实际结束不晚于 A 的最大实际结束（没有则计 0；
 *      实际结束晚于 A 的提示不算当时阻塞）。
 * 达到 R 的约束（起点约束与通道约束可能并列达到）连同相关提示一并列出。
 * 未开始（未登记实际开始）的提示不拆解，标记为「未分析」。
 * 计算只使用本次冻结的提示单 / 计划与当前登记记录；排练外对原提示单的编辑不影响结果，
 * 计算过程也不回写冻结计划或登记记录。
 */

const { round } = require('./scheduler');

const EPS = 1e-9; // 与调度 / 冲突检测一致的浮点容差

function recOf(rehearsal, cueId) {
  const rec = rehearsal.records[cueId];
  if (!rec) return { actualStart: null, actualEnd: null };
  return {
    actualStart: rec.actualStart === undefined ? null : rec.actualStart,
    actualEnd: rec.actualEnd === undefined ? null : rec.actualEnd,
  };
}

/**
 * 计算每条提示的起点偏差拆解。
 * 返回 Map：cueId →
 *   未开始：{ cueId, analyzed: false }
 *   已开始：{ cueId, analyzed: true, plannedStart, actualStart, releaseAt,
 *            constraints: [...达到 R 的约束...], shift, wait, total }
 * 约束对象：
 *   { kind: 'fixed', value }
 *   { kind: 'predecessor', value, cueId, cueName, actualEnd, delayAfter }
 *   { kind: 'channel', value, channel, cues: [{ cueId, name, actualEnd }] }
 */
function deviationBreakdown(rehearsal) {
  const schedMap = new Map(rehearsal.schedule.map((s) => [s.id, s]));
  const byId = new Map(rehearsal.cues.map((c) => [c.id, c]));
  const out = new Map();

  for (const cue of rehearsal.cues) {
    const rec = recOf(rehearsal, cue.id);
    if (rec.actualStart === null) {
      out.set(cue.id, { cueId: cue.id, analyzed: false });
      continue;
    }

    const A = rec.actualStart;
    const t = schedMap.get(cue.id);
    const P = t && t.start !== null && t.start !== undefined ? t.start : null;

    // 约束 1：起点约束（固定秒数 / 前置实际结束 + 延迟）
    let origin;
    if (cue.startType === 'after') {
      const pred = byId.get(cue.afterCueId) || null;
      const predEnd = recOf(rehearsal, cue.afterCueId).actualEnd;
      origin = {
        kind: 'predecessor',
        // 登记开始条件与勘误整体校验保证相对提示开始时前置必有实际结束；
        // 数据异常缺失时该约束 value 为 null，不参与取大。
        value: predEnd === null ? null : round(predEnd + cue.delayAfter),
        cueId: cue.afterCueId,
        cueName: pred ? pred.name : null,
        actualEnd: predEnd,
        delayAfter: cue.delayAfter,
      };
    } else {
      origin = { kind: 'fixed', value: cue.fixedAt };
    }

    // 约束 2：通道约束（同通道其他提示中实际结束 ≤ A 的最大值，没有则 0）
    let bestEnd = null;
    let blockers = [];
    for (const other of rehearsal.cues) {
      if (other.id === cue.id || other.channel !== cue.channel) continue;
      const end = recOf(rehearsal, other.id).actualEnd;
      if (end === null || end > A + EPS) continue; // 无实际结束 / A 之后才结束的不算当时阻塞
      if (bestEnd === null || end > bestEnd + EPS) {
        bestEnd = end;
        blockers = [{ cueId: other.id, name: other.name, actualEnd: end }];
      } else if (Math.abs(end - bestEnd) <= EPS) {
        // 同一时刻结束的同通道提示（如零时长首尾相接）都作为相关提示列出
        blockers.push({ cueId: other.id, name: other.name, actualEnd: end });
      }
    }
    const channel = {
      kind: 'channel',
      value: bestEnd === null ? 0 : bestEnd,
      channel: cue.channel,
      cues: blockers, // 实际结束达到该最大值的相关提示（可能多条；为空表示通道约束取默认 0）
    };

    // R = 各约束的最大值；达到 R 的约束全部列出（起点 / 通道可能并列）
    const candidates = [origin, channel].filter((c) => c.value !== null);
    const R = round(Math.max(...candidates.map((c) => c.value)));
    const constraints = candidates.filter((c) => Math.abs(c.value - R) <= EPS);

    out.set(cue.id, {
      cueId: cue.id,
      analyzed: true,
      plannedStart: P,
      actualStart: A,
      releaseAt: R,
      constraints,
      shift: P === null ? null : round(R - P), // 约束位移（可为负）
      wait: round(A - R), // 额外等待
      total: P === null ? null : round(A - P), // 总偏差；恒等于 shift + wait
    });
  }

  return out;
}

module.exports = { deviationBreakdown };

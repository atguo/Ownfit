// 推荐请求内部输入 V2（全部计划评估 §8.2，2026-11-04）：
// 入队即固定"实际发送档案 + 真实单品身份 + 锁定/基线/允许变化范围"的不可变快照，
// 执行与采用都只依据快照复核，不按当前衣橱重建映射（旧 R4 的别名漂移根因）。
// 纯模块：无 IO、无 react；store（features）与 runner（services）共同消费。
// 版本规则（§8.9）：内部输入 DTO 用 inputVersion 字段演进，写在现有 tasks.input_json；
// 无 inputVersion 的旧记录视为 V1（历史兼容：queued 标 stale，成功候选不提供受约束采用）。

import type { ProfileItem, SlotRole } from './recommendationService';
import { canonicalJson } from './canonical';

export const RECOMMENDATION_INPUT_VERSION = 2;

/** 快照内的单品：真实 ID + 本次请求传输别名 + 入队时资料版本 + 实际发送的档案内容 */
export interface SnapshotProfileItem {
  realId: string;
  alias: string;
  revision: number;
  name: string | null;
  category: string | null;
  attributes: ProfileItem['attributes'];
  colors: ProfileItem['colors'];
}

/** 局部替换的基线组合（采用前复核：会话已变化则拒绝采用） */
export interface RecommendationBaseline {
  /** 槽位 → 真实单品 ID（仅含在案槽位） */
  slots: Record<string, string>;
  wear: string;
  /** 槽位 → 逐件穿法（仅显式设置项） */
  slotWear: Record<string, string>;
}

export interface RecommendationSceneSnapshot {
  city: string;
  day: string;
  scene: string;
  temp?: string;
  tempSource?: string;
  weatherDesc?: string;
  /** 入队时解析的本地具体日期（yyyy-MM-dd）；跨日不重新解释"今天"（§8.6） */
  targetDate: string;
}

/** 推荐请求快照（schema v5 的 tasks.input_json，inputVersion=2） */
export interface RecommendationInputV2 {
  inputVersion: typeof RECOMMENDATION_INPUT_VERSION;
  createdAt: string;
  /** 实际发送的档案（预算截取后；别名编号保持全柜口径） */
  items: SnapshotProfileItem[];
  truncated: boolean;
  totalCount: number;
  /** 用户锁定的真实单品 ID（都在 items 内；执行/采用按此复核，不静默舍弃） */
  lockedRealIds: string[];
  scene: RecommendationSceneSnapshot;
  body: { heightCm?: number; weightKg?: number } | null;
  preferences: string[];
  note: string | null;
  /** full=整套推荐；replace_slot=局部替换（F8：只允许目标槽位变化） */
  mode: 'full' | 'replace_slot';
  /** 入队时的组合基线；replace_slot 必填，full 也记录供采用复核 */
  baseline: RecommendationBaseline | null;
  /** replace_slot 的目标槽位（会话槽位名 top/dress/bottom/shoes/outer） */
  targetSlot: string | null;
}

/** 本地时区 yyyy-MM-dd（相对今天偏移 0/1 天）；跨日判定与指纹都按具体日期 */
export function localTargetDate(dayLabel: string, now: Date = new Date()): string {
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (dayLabel === '明天') date.setDate(date.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 规范化 JSON：见 services/ai/canonical（对象按键排序、数组保序；§8.2.3） */
export { canonicalJson };

/** 输入指纹 V2：真实 ID+版本、锁定、场景（含具体日期）、偏好/要求、基线与允许变化槽位、
 * 配置与提示词版本全部纳入；内容相同但键序不同的输入得到同一指纹。 */
export function buildRecommendationInputKeyV2(input: {
  stored: Omit<RecommendationInputV2, 'inputVersion' | 'createdAt'>;
  configId: string;
  configRevision: string;
  contractVersion: string;
  promptVersion: string;
}): string {
  const s = input.stored;
  return canonicalJson({
    inputVersion: RECOMMENDATION_INPUT_VERSION,
    items: [...s.items]
      .map((item) => ({ realId: item.realId, alias: item.alias, revision: item.revision }))
      .sort((a, b) => (a.realId < b.realId ? -1 : 1)),
    truncated: s.truncated,
    totalCount: s.totalCount,
    lockedRealIds: [...s.lockedRealIds].sort(),
    scene: s.scene,
    body: s.body ?? null,
    preferences: [...s.preferences].sort(),
    note: s.note,
    mode: s.mode,
    baseline: s.baseline
      ? {
          slots: s.baseline.slots,
          wear: s.baseline.wear,
          slotWear: s.baseline.slotWear,
        }
      : null,
    targetSlot: s.targetSlot,
    configId: input.configId,
    configRevision: input.configRevision,
    contractVersion: input.contractVersion,
    promptVersion: input.promptVersion,
  });
}

/** 安全解析：仅接受 inputVersion=2 的完整快照；旧格式/损坏返回 null（调用方按历史兼容处理） */
export function parseRecommendationInputV2(inputJson: string | null): RecommendationInputV2 | null {
  if (!inputJson) return null;
  try {
    const parsed = JSON.parse(inputJson) as RecommendationInputV2;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.inputVersion !== RECOMMENDATION_INPUT_VERSION) return null;
    if (!Array.isArray(parsed.items)) return null;
    if (!parsed.scene || typeof parsed.scene.targetDate !== 'string') return null;
    if (parsed.mode !== 'full' && parsed.mode !== 'replace_slot') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 快照别名 → 真实 ID 固定映射（执行/校验用；不按当前衣橱重建） */
export function aliasMapOf(stored: RecommendationInputV2): Map<string, string> {
  return new Map(stored.items.map((item) => [item.alias, item.realId]));
}

/** 局部替换候选的本地校验输入（§8.2.4/§8.2.5）：锁定件必须原样出现，
 * 只允许目标槽位换成档案内可用品类一致的替代件，不得新增/移除其他槽位。 */
export interface ReplacementRule {
  /** 锁定（保持不变）的别名 */
  lockedAliases: string[];
  /** 允许变化的目标槽位（服务层槽位名：top/bottom/dress/shoes/outerwear） */
  targetRole: SlotRole;
  /** 基线槽位 → 别名（用于判断"新增了基线外的槽位"） */
  baselineRoles: Partial<Record<SlotRole, string>>;
}

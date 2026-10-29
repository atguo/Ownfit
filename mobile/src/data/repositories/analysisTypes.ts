// 衣物分析跨批共享类型（分批执行手册 §3.3 + 字段来源重构设计）。
// 约束：只依赖 contract 的类型，不导入 UI、配置存储或任务执行器。
// 后续批次必须复用这里的形状，不得各自创建同名不兼容类型。

import type { GarmentAnalysis, GarmentColor } from '@ownfit/contract';

/** 当前只支持衣物分析一种任务类型 */
export const GARMENT_ANALYSIS_KIND = 'garment_analysis';
export type AnalysisKind = typeof GARMENT_ANALYSIS_KIND;

/** 任务状态机：queued -> running -> succeeded | failed | interrupted | stale | cancelled，另有 blocked */
export type AnalysisTaskStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'interrupted'
  | 'stale'
  | 'cancelled'
  | 'blocked';

/** 触发来源：新照片自动、衣橱批量补分析、详情手动、失败/中断/过期后手动重试 */
export type AnalysisTrigger = 'auto' | 'batch' | 'manual' | 'retry';

/** 拒绝创建任务的原因（业务级拒绝，不含数据库异常） */
export type RejectReason =
  | 'item_missing'
  | 'item_unavailable'
  | 'photo_missing'
  | 'config_missing'
  | 'config_invalid'
  | 'config_changed'
  | 'retry_target_invalid';

/** 属性来源三态（重构设计 §6）：AI 推断=灰、用户确认=绿、用户输入=强调色 */
export type AttrSource = 'ai_inferred' | 'user_confirmed' | 'user_entered';

/** 测量条目（用户录入；AI 永不写） */
export interface Measurement {
  name: string;
  amount: string;
  unit: string;
  note?: string;
}

/** 颜色库条目（用户确认过的颜色集合，跨单品共用） */
export interface ColorEntry {
  name: string;
  hex: string;
  addedAt: string;
}

/** 动态细节属性行的展示形状：同名取最新一行 */
export interface DynamicAttribute {
  name: string;
  value: string;
  source: AttrSource;
  recordedAt: string;
  analysisTaskId: string | null;
}

/** tasks 表的 camelCase 映射；不得包含 API Key 或密钥引用 */
export interface AnalysisTask {
  id: string;
  kind: AnalysisKind;
  itemId: string;
  status: AnalysisTaskStatus;
  inputRevision: number;
  attempt: number;
  photoId: string;
  /** 输入指纹：itemId/revision/photoId/configId/configRevision/contractVersion/promptVersion 的固定顺序 JSON */
  inputKey: string;
  /** 一次主动提交的幂等键，全局唯一 */
  requestKey: string;
  configId: string;
  /** 配置快照（白名单 JSON：id/name/urlKind/baseUrl/modelId），不含密钥 */
  configSnapshot: string;
  configRevision: string;
  contractVersion: string;
  promptVersion: string;
  retryOfTaskId: string | null;
  resultJson: string | null;
  errorKind: string | null;
  errorSummary: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * 详情/列表读取视图（字段来源重构设计 §9）：
 * - lastValidResult：当前照片最新"有效"成功任务（2.0 契约、single、人工未改照片）；
 *   内置字段（品类建议/名称建议/颜色）从这里读取
 * - attributes：动态细节属性行（同名取最新），按品类推荐键排序
 * - colors：用户确认行优先；无人工行时回退 AI 结果颜色
 * - measurements：测量列表（仅用户录入）
 * - suggestedName：AI 名称建议（采纳后写入 items.name）
 */
export interface AnalysisView {
  latestTask: AnalysisTask | null;
  lastValidResult: {
    taskId: string;
    result: GarmentAnalysis;
    completedAt: string;
    modelName: string;
  } | null;
  /** 用户确认的品类（内置；来自 items.category） */
  category: { value: string | null; source: 'user_confirmed' };
  /** AI 名称建议（采纳后写入 items.name） */
  suggestedName: { value: string | null; source: 'ai_inferred' } | null;
  colors: { value: GarmentColor[]; source: AttrSource };
  attributes: DynamicAttribute[];
  measurements: { list: Measurement[]; source: AttrSource } | null;
}

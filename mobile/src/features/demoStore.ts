// 演示与首页状态（M3 瘦身后）：
// - context：当次场景（首页场景条；保存方案时作为场景快照）
// - newUser：首页新用户引导（组件展示页可切换，演示隔离用）
// - reference：人物参考状态（预览能力 M5 接入后使用）
// - prefs：穿衣偏好的展示镜像（持久化在 SQLite，经 settingsRepository 读写）
// 真实衣橱与方案数据在 SQLite（src/data/repositories/），与此文件零交集。

import { useSyncExternalStore } from 'react';

export interface DemoContext {
  city: string;
  day: '今天' | '明天';
  scene: string;
  temp: string;
  /** 天气描述（实时查得）或“手动填写”；演示态为“晴间多云（演示）” */
  weatherDesc: string;
  /** 温度来源：演示 / 实时 / 手动，三者可区分（天气文档 §4：手动与服务数据可区分） */
  tempSource: 'demo' | 'real' | 'manual';
  /** 实时天气的获取时间（ISO，本地展示）；仅 tempSource='real' 时有值（M6 批次 1.3） */
  weatherFetchedAt?: string;
  /** F4：实时天气归属的目标日期（本地 yyyy-MM-dd）——跨日即失效，不让"今天"被重新解释 */
  weatherTargetDate?: string;
  /** F4：实时天气归属地点（城市名）——与当次地点不一致即失效 */
  weatherPlace?: string;
  /** F4：当次条件版本。用户改动地点/日期/手动温度时递增；自动写回只有在请求期间
   * 版本未变才生效（迟到响应不得覆盖用户改动；定位/天气的内部更新不递增版本） */
  conditionRevision: number;
}

export interface DemoState {
  context: DemoContext;
  newUser: boolean;
  reference: boolean;
  prefs: string[];
}

/** 示例天气占位（首页始终显示温度；未查实时/未手动填写时的明确标注占位） */
export const DEMO_WEATHER = { temp: '18–24℃', weatherDesc: '晴间多云（演示）' } as const;

const initial: DemoState = {
  context: {
    city: '杭州',
    day: '今天',
    scene: '日常通勤',
    ...DEMO_WEATHER,
    tempSource: 'demo',
    conditionRevision: 0,
  },
  newUser: false,
  reference: false,
  prefs: [],
};

let state: DemoState = initial;
const listeners = new Set<() => void>();

function set(change: Partial<DemoState>) {
  state = { ...state, ...change };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useDemoStore(): DemoState {
  return useSyncExternalStore(subscribe, () => state);
}

/**
 * 当次 context 更新（F4，评估 §8.6）：默认视为用户改动（地点/日期/手动温度等），
 * 递增 conditionRevision 使在途天气请求的写回失效；
 * 定位/天气编排的内部更新传 { internal: true }，不递增版本（不得让自己误触发失效）。
 */
export function setContext(change: Partial<DemoContext>, options: { internal?: boolean } = {}) {
  const revision = options.internal
    ? state.context.conditionRevision
    : state.context.conditionRevision + 1;
  set({ context: { ...state.context, ...change, conditionRevision: revision } });
}

/** 当次场景快照（保存方案时写入 scene 字段；当次调整不写回长期默认） */
export function getContextSnapshot() {
  return { ...state.context };
}

export function setReference(reference: boolean) {
  set({ reference });
}

export function setPrefs(prefs: string[]) {
  set({ prefs });
}

/** 重置演示（组件展示页）：newUser 影响首页引导与衣橱空态演示 */
export function resetDemo(mode: 'default' | 'newUser') {
  set({ ...initial, newUser: mode === 'newUser' });
}

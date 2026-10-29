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
}

export interface DemoState {
  context: DemoContext;
  newUser: boolean;
  reference: boolean;
  prefs: string[];
}

const initial: DemoState = {
  context: { city: '杭州', day: '今天', scene: '日常通勤', temp: '18–24℃' },
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

export function setContext(change: Partial<DemoContext>) {
  set({ context: { ...state.context, ...change } });
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

import { useSyncExternalStore } from 'react';
import { demoItems, type DemoItem, type ItemCategory } from '../data/demo';

// M1 演示状态：仅内存（进程结束即失），结构对齐原型 app.js 的 data + state。
// 业务规则的真实实现属 M2/M3；这里只做界面状态承载，供页面与弹层联动。

export interface SavedOutfit {
  id: string;
  name: string;
  top: string;
  ids: string[];
  select: string;
  wear: string;
  scene: string;
  worn: boolean;
  satisfied: boolean;
}

export interface DemoContext {
  city: string;
  day: string;
  scene: string;
  temp: string;
}

interface Snapshot {
  top: string;
  locks: string[];
  wear: string;
  select: string;
  version: number;
}

export interface DemoState {
  items: DemoItem[];
  saved: SavedOutfit[];
  prefs: string[];
  context: DemoContext;
  newUser: boolean;
  reference: boolean;
  // 搭配交互状态（原型 state）
  top: string;
  select: string;
  locks: string[];
  wear: string;
  version: number;
  previewVersion: number;
  previewLook: number;
  compare: boolean;
}

const initial: DemoState = {
  items: demoItems.map((item) => ({ ...item })),
  saved: [],
  prefs: ['简约日常', '宽松一些'],
  context: { city: '杭州', day: '今天', scene: '日常通勤', temp: '18–24℃' },
  newUser: false,
  reference: false,
  top: 'knit',
  select: 'pants',
  locks: ['pants'],
  wear: '自然垂放',
  version: 1,
  previewVersion: 0,
  previewLook: 0,
  compare: false,
};

let state: DemoState = initial;
let history: Snapshot[] = [];
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

// 页面读取整份快照即可；M1 数据量小，不拆分选择器。
export function useDemoStore(): DemoState {
  return useSyncExternalStore(subscribe, () => state);
}

export function getItem(id: string): DemoItem | undefined {
  return state.items.find((item) => item.id === id);
}

const snapshot = (): Snapshot => ({
  top: state.top,
  locks: [...state.locks],
  wear: state.wear,
  select: state.select,
  version: state.version,
});

// 原型 edit()：任何修改入撤销栈、版本 +1、预览过期
export function outfitEdit(change: Partial<Pick<DemoState, 'top' | 'select' | 'locks' | 'wear'>>) {
  history.push(snapshot());
  set({ ...change, version: state.version + 1, previewVersion: 0 });
}

export function outfitUndo(): boolean {
  const prev = history.pop();
  if (!prev) return false;
  set({ ...prev, previewVersion: 0 });
  return true;
}

export function outfitHistoryLength(): number {
  return history.length;
}

// 原型 build()：从选择的基础单品进入搭配
export function buildOutfit(selectId: string): boolean {
  const selected = getItem(selectId);
  if (!selected) return false;
  history = [];
  set({
    top: selected.cat === '上衣' ? selectId : 'knit',
    select: selectId,
    locks: [selectId],
    version: state.version + 1,
    previewVersion: 0,
  });
  return true;
}

// 原型 getPieces()：搭配板与清单的单品集合
export function getPieceIds(): string[] {
  const selected = getItem(state.select);
  const ids = [state.top, selected && selected.cat === '下装' ? selected.id : 'pants', 'shoes'];
  if (selected && !ids.includes(selected.id)) ids.push(selected.id);
  return [...new Set(ids)];
}

export function toggleLock(id: string) {
  set({
    locks: state.locks.includes(id)
      ? state.locks.filter((x) => x !== id)
      : [...state.locks, id],
  });
}

// 原型 save()：同组合同穿法去重
export function saveOutfit(): 'saved' | 'duplicate' {
  const ids = getPieceIds();
  const existing = state.saved.find(
    (s) => JSON.stringify(s.ids) === JSON.stringify(ids) && s.wear === state.wear,
  );
  if (existing) return 'duplicate';
  const saved: SavedOutfit = {
    id: Date.now().toString(),
    name: state.top === 'sage' ? '绿意里的松弛日常' : '轻盈日常',
    top: state.top,
    ids,
    select: state.select,
    wear: state.wear,
    scene: state.context.scene,
    worn: false,
    satisfied: false,
  };
  set({ saved: [saved, ...state.saved] });
  return 'saved';
}

/** 当前搭配是否已收藏（用于收藏钮的已收藏态） */
export function isCurrentSaved(): boolean {
  const ids = getPieceIds();
  return state.saved.some(
    (s) => JSON.stringify(s.ids) === JSON.stringify(ids) && s.wear === state.wear,
  );
}

/** 原型 reuse：从收藏复用进搭配页 */
export function reuseOutfit(id: string): boolean {
  const source = state.saved.find((s) => s.id === id);
  if (!source) return false;
  history = [];
  set({
    top: source.top,
    select: source.select || 'pants',
    locks: [source.select || 'pants'],
    wear: source.wear,
    version: state.version + 1,
    previewVersion: 0,
  });
  return true;
}

/** 原型 markPreviewReady：预览计时完成，示意图与当前版本对齐 */
export function markPreviewReady() {
  set({
    previewVersion: state.version,
    previewLook: state.top === 'sage' ? 1 : 0,
  });
}

/** 原型 select：选择页选中基础单品（不入撤销栈） */
export function setSelect(id: string) {
  set({ select: id });
}

/** 原型 preview-mode：单套查看 / 两套比较 */
export function setCompare(compare: boolean) {
  set({ compare });
}

export function markWorn(id: string, value: 'happy' | 'unhappy' | 'skip') {
  set({
    saved: state.saved.map((s) =>
      s.id === id ? { ...s, worn: true, satisfied: value === 'happy' } : s,
    ),
  });
}

export function setContext(change: Partial<DemoContext>) {
  set({ context: { ...state.context, ...change } });
}

export function togglePref(pref: string) {
  set({
    prefs: state.prefs.includes(pref)
      ? state.prefs.filter((p) => p !== pref)
      : [...state.prefs, pref],
  });
}

/** 用持久化值同步展示状态（M2：偏好来自 SQLite） */
export function setPrefs(prefs: string[]) {
  set({ prefs });
}

export function setReference(reference: boolean) {
  set({ reference, previewVersion: 0 });
}

export function addItem(item: { name: string; cat: ItemCategory }) {
  const created: DemoItem = {
    id: `local-${Date.now()}`,
    name: item.name,
    cat: item.cat,
    color: '尚未确认',
    x: 0,
    y: 100,
  };
  set({ items: [...state.items, created] });
  return created;
}

// 原型 reset：恢复初始示例 / 体验首次空衣橱
export function resetDemo(mode: 'default' | 'newUser') {
  history = [];
  set({ ...initial, newUser: mode === 'newUser', items: demoItems.map((i) => ({ ...i })) });
}

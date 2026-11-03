// 方案（收藏）仓库：保存/列表/读取/复用与穿着记录。
// 保存前必须通过业务契约校验（@ownfit/contract）；穿过记录遵循
// "收藏不自动标记穿过；跳过评价保留未知"（M3 通过条件）。

import { getDb } from '../db';
import { parsePlan, type Plan, type PlanItem, type SceneSnapshot, type Wear } from '@ownfit/contract';
import { photoUri } from './photoRepository';

export interface SavedPlan {
  id: string;
  parentId: string | null;
  version: number;
  name: string | null;
  basisItemId: string;
  wear: Wear;
  reason: string | null;
  /** 保存时的场景快照（仓库层放宽为 string；契约层为强类型枚举） */
  scene: { city: string; day: string; scene: string };
  source: string;
  /** 按位置排序的单品引用（role 在 planItems 内） */
  items: PlanItem[];
  mainThumbUri: string | null;
  /** 穿过状态（由 worn_records 派生）：null=未穿过；'yes'/'no'=已穿过且满意/不满意；'unknown'=穿过未评价 */
  wornState: 'unworn' | 'yes' | 'no' | 'unknown';
  createdAt: string;
  updatedAt: string;
}

export interface PlanInput {
  id?: string;
  parentId?: string | null;
  basisItemId: string;
  /** 单品与角色；wearStyle 为逐件穿法（契约 v1.1.0，可省略=按顶层 wear） */
  itemIds: { itemId: string; role: PlanItem['role']; wearStyle?: string }[];
  wear: Wear;
  reason?: string | null;
  scene: SceneSnapshot;
  /** 方案来源（契约 Plan.source）；缺省 'manual' */
  source?: 'manual' | 'ai';
}

function newId(): string {
  return `plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 从契约 Plan 构造持久化输入（保证写入前已过契约校验——校验由调用方显式执行） */
export function planInputFromContract(plan: Plan): PlanInput {
  return {
    id: plan.planId,
    parentId: plan.parentPlanId,
    basisItemId: plan.items.find((item) => item.role === 'basis')!.itemId,
    itemIds: plan.items.map((item) => ({
      itemId: item.itemId,
      role: item.role,
      ...(item.wearStyle ? { wearStyle: item.wearStyle } : null),
    })),
    wear: plan.wear,
    reason: plan.reason,
    scene: plan.scene,
    source: plan.source,
  };
}

/** 保存方案（新增或新版本）。调用方负责：契约校验（parsePlan）与去重提示。 */
export async function savePlan(input: PlanInput, name: string | null): Promise<SavedPlan> {
  const db = await getDb();
  const id = input.id ?? newId();
  const now = new Date().toISOString();

  await db.withTransactionAsync(async () => {
    for (const item of input.itemIds) {
      const current = await db.getFirstAsync<{ status: string }>('SELECT status FROM items WHERE id = ?', item.itemId);
      if (!current || current.status !== 'active') throw new Error('搭配含已删除或不可用的衣物，请重新选择后保存');
    }
    await db.runAsync(
      `INSERT INTO plans (id, parent_id, version, name, basis_item_id, wear_slot, wear_style, reason,
         scene_city, scene_day, scene_name, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         parent_id = excluded.parent_id, version = excluded.version, name = excluded.name,
         basis_item_id = excluded.basis_item_id, wear_slot = excluded.wear_slot,
         wear_style = excluded.wear_style, reason = excluded.reason,
         scene_city = excluded.scene_city, scene_day = excluded.scene_day,
         scene_name = excluded.scene_name, source = excluded.source, updated_at = excluded.updated_at`,
      id,
      input.parentId ?? null,
      1,
      name,
      input.basisItemId,
      input.wear.slot,
      input.wear.style,
      input.reason ?? null,
      input.scene.city,
      input.scene.day,
      input.scene.scene,
      input.source ?? 'manual',
      now,
      now,
    );
    await db.runAsync('DELETE FROM plan_items WHERE plan_id = ?', id);
    for (const [position, item] of input.itemIds.entries()) {
      // C4：逐件穿法随 plan_items 持久化（v7 wear_style 列；null=按顶层 wear）
      await db.runAsync(
        'INSERT INTO plan_items (plan_id, item_id, role, position, wear_style) VALUES (?, ?, ?, ?, ?)',
        id,
        item.itemId,
        item.role,
        position,
        item.wearStyle ?? null,
      );
    }
  });

  const saved = await getPlan(id);
  if (!saved) throw new Error('方案保存后读取失败');
  return saved;
}

interface PlanRow {
  id: string;
  parent_id: string | null;
  version: number;
  name: string | null;
  basis_item_id: string;
  wear_slot: string;
  wear_style: string;
  reason: string | null;
  scene_city: string | null;
  scene_day: string | null;
  scene_name: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}

async function hydratePlan(row: PlanRow): Promise<SavedPlan> {
  const db = await getDb();
  const itemRows = await db.getAllAsync<{ item_id: string; role: string; wear_style: string | null }>(
    'SELECT item_id, role, wear_style FROM plan_items WHERE plan_id = ? ORDER BY position',
    row.id,
  );
  const items: PlanItem[] = itemRows.map((r) => ({
    itemId: r.item_id,
    role: r.role as PlanItem['role'],
    // C4：逐件穿法回读（null=按顶层 wear，不输出字段）
    ...(r.wear_style ? { wearStyle: r.wear_style as PlanItem['wearStyle'] } : null),
  }));
  const worn = await db.getFirstAsync<{ satisfied: string | null }>(
    'SELECT satisfied FROM worn_records WHERE plan_id = ? ORDER BY worn_at DESC LIMIT 1',
    row.id,
  );
  const thumb = await db.getFirstAsync<{ thumb_path: string }>(
    `SELECT p.thumb_path FROM photos p JOIN plan_items pi ON pi.item_id = p.item_id
     WHERE pi.plan_id = ? AND p.kind = 'main' LIMIT 1`,
    row.id,
  );

  const wornState: SavedPlan['wornState'] = !worn
    ? 'unworn'
    : worn.satisfied === 'yes'
      ? 'yes'
      : worn.satisfied === 'no'
        ? 'no'
        : 'unknown';

  return {
    id: row.id,
    parentId: row.parent_id,
    version: row.version,
    name: row.name,
    basisItemId: row.basis_item_id,
    wear: { slot: row.wear_slot as Wear['slot'], style: row.wear_style as Wear['style'] },
    reason: row.reason,
    scene: { city: row.scene_city ?? '', day: row.scene_day ?? '', scene: row.scene_name ?? '' },
    source: row.source,
    items,
    mainThumbUri: thumb?.thumb_path ? photoUri(thumb.thumb_path) : null,
    wornState,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getPlan(id: string): Promise<SavedPlan | undefined> {
  const db = await getDb();
  const row = await db.getFirstAsync<PlanRow>('SELECT * FROM plans WHERE id = ?', id);
  return row ? hydratePlan(row) : undefined;
}

/** 收藏列表（按更新时间倒序） */
export async function listPlans(): Promise<SavedPlan[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<PlanRow>('SELECT * FROM plans ORDER BY updated_at DESC');
  const plans: SavedPlan[] = [];
  for (const row of rows) plans.push(await hydratePlan(row));
  return plans;
}

/** 同组合同穿法去重（原型 save() 规则）：存在返回既有一览 */
export async function findDuplicate(
  itemIds: string[],
  wearStyle: Wear['style'],
): Promise<SavedPlan | undefined> {
  const plans = await listPlans();
  const key = (ids: string[]) => JSON.stringify([...ids].sort());
  return plans.find((p) => key(p.items.map((i) => i.itemId)) === key(itemIds) && p.wear.style === wearStyle);
}

/** 记录穿着与感受。satisfied=null 表示"先只记录穿过"（保留未知，不视为满意）。
 * reasons（D3，2026-11-04 提前实现）：可跳过的最小原因（多选，JSON 数组存 worn_records.reasons）；
 * 关联方案版本，用于区分"推荐不适合"与"预览误导"等归因，默认可不填。 */
export async function recordWorn(
  planId: string,
  value: 'happy' | 'unhappy' | 'skip',
  note?: string,
  reasons?: string[],
): Promise<void> {
  const db = await getDb();
  const cleanReasons = (reasons ?? []).filter((r) => typeof r === 'string' && !!r.trim()).slice(0, 6);
  await db.runAsync(
    'INSERT INTO worn_records (id, plan_id, worn_at, satisfied, note, reasons) VALUES (?, ?, ?, ?, ?, ?)',
    `worn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    planId,
    new Date().toISOString(),
    value === 'happy' ? 'yes' : value === 'unhappy' ? 'no' : null,
    note ?? null,
    cleanReasons.length ? JSON.stringify(cleanReasons) : null,
  );
}

/** 删除方案（收藏移除）。穿着记录级联删除。 */
export async function deletePlan(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM worn_records WHERE plan_id = ?', id);
  await db.runAsync('DELETE FROM plan_items WHERE plan_id = ?', id);
  await db.runAsync('DELETE FROM plans WHERE id = ?', id);
}

/** 契约 Plan → 持久化（含契约校验；失败抛出，调用方不保存） */
export async function saveContractPlan(plan: Plan, name: string | null): Promise<SavedPlan> {
  const parsed = parsePlan(plan);
  if (!parsed.ok) throw new Error(parsed.error);
  return savePlan(
    {
      id: plan.planId,
      parentId: plan.parentPlanId,
      basisItemId: plan.items.find((i) => i.role === 'basis')!.itemId,
      itemIds: plan.items.map((i) => ({
        itemId: i.itemId,
        role: i.role,
        ...(i.wearStyle ? { wearStyle: i.wearStyle } : null),
      })),
      wear: plan.wear,
      reason: plan.reason,
      scene: plan.scene,
      source: plan.source,
    },
    name,
  );
}

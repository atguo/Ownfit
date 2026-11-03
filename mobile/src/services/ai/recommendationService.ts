// 搭配推荐服务（M5 轨 B4）：提示词组装、模型返回解析与归一化、输入指纹。
// 纯函数，无 IO；提示词与 experiments 包 src/outfit-recommendation 同源（保持一致）。
// 红线：只用档案内单品（校验引用）；数据不足显式 gaps，不用不存在的单品凑数；
// 不输出合身/保暖等结论。

export const RECOMMENDATION_PROMPT_VERSION = '4';
export const RECOMMENDATION_CONTRACT_VERSION = 'outfit-recommendation-1';

export interface ProfileItem {
  id: string;
  name: string | null;
  category: string | null;
  attributes: Array<{ name: string; value: string }>;
  colors: Array<{ name: string; hex: string }>;
}

/** 穿法白名单（与 features/outfitSession 的 WearStyle 保持一致；services 层不反向依赖 UI 层） */
export const WEAR_STYLE_VALUES = ['自然垂放', '前侧塞衣角', '外层敞开穿'] as const;

export const ROLE_VALUES = ['top', 'bottom', 'dress', 'shoes', 'outerwear', 'bag', 'accessory'] as const;
export type SlotRole = (typeof ROLE_VALUES)[number];

/** 模型候选（已归一化为真实单品 ID） */
export interface RecommendationCandidate {
  slots: Array<{ role: SlotRole; itemId: string; note?: string }>;
  wearStyle: string;
  reason?: string;
}

export interface RecommendationResult {
  candidates: RecommendationCandidate[];
  gaps: string[];
  summary?: string;
}

const ROLE_ALIASES: Record<string, SlotRole> = {
  top: 'top', tops: 'top',
  bottom: 'bottom', bottoms: 'bottom',
  dress: 'dress', dresses: 'dress',
  shoes: 'shoes',
  outerwear: 'outerwear', outer: 'outerwear',
  bag: 'bag', bags: 'bag',
  accessory: 'accessory', accessories: 'accessory',
};

const WEAR_STYLES: string[] = [...WEAR_STYLE_VALUES];

export function recommendationSystemPrompt(): string {
  return [
    '你是个人穿搭助理。根据用户的真实衣物档案，给出可执行的穿搭候选组合。',
    '规则：',
    '1. 只使用档案里出现过的单品 ID，绝不虚构不存在的衣物或新的属性。',
    '2. 组合要覆盖合理槽位（上衣/下装/连衣裙其一 + 鞋履；外套为可选外层）。',
    '   role 只能取：top、bottom、dress、shoes、outerwear（单数，不要用 bottoms）。',
    '   包、配饰本期不支持，不要输出。',
    '3. 同一候选内不要出现重复单品；连衣裙不要与上衣或下装同时出现；',
    '   同一 role 只出现一次（top 与 outerwear 可共存）。',
    '4. 数据不足时不要凑数：把缺的槽位写进 gaps（例如"没有鞋履可搭"），不要用不存在的单品填补。',
    '5. wearStyle 只能是：自然垂放、前侧塞衣角、外层敞开穿。',
    '6. 用户给出"已锁定单品"时，每个候选都必须包含这些单品。',
    '7. 候选之间要有真实差别（正式程度/配色/层次/活动便利性），不要给出只换顺序的重复组合；',
    '   没有足够差异时宁可少给，不凑数量。',
    '8. reason 用一句话说明搭配思路（风格/场合/颜色协调），关联到候选里的真实单品，',
    '   不要下合身、保暖、显瘦等结论——单凭照片与档案无法判断这些。',
    '9. 输出紧凑 JSON，不要解释文字、不要代码围栏。结构：',
    '{"candidates":[{"slots":[{"role":"top","itemId":"item-xxx","note":"可选说明"}],"wearStyle":"自然垂放","reason":"可选一句话"}],"gaps":["缺口说明"],"summary":"可选总述"}',
  ].join('\n');
}

export function recommendationUserPrompt(input: {
  items: ProfileItem[];
  scene: { city: string; day: string; scene: string; temp?: string; tempSource?: string; weatherDesc?: string };
  /** 用户身材资料（身高/体重选填，M6 批次 2）；仅作体型参考，不要求合身结论 */
  body?: { heightCm?: number; weightKg?: number } | null;
  /** 用户当前搭配中已锁定的单品（别名 id）；非空时组合必须包含 */
  lockedAliases?: string[];
  /** 长期偏好（全部参与排序，非硬性约束；B1：不再只取首个偏好作场景兜底） */
  preferences?: string[];
  /** 当次要求（如"只换鞋""更正式一点""步行 20 分钟"）；仅本次请求有效 */
  note?: string | null;
  /** B2：档案截取时的如实说明（不静默丢弃） */
  profileNote?: string;
}): string {
  const body = input.items.length
    ? input.items
        .map((item) => {
          const attrs = item.attributes.map((a) => `${a.name}:${a.value}`).join('，');
          const colorText = item.colors.map((c) => c.name).join('/');
          return [
            `- id=${item.id}`,
            `品类=${item.category ?? '未知'}`,
            `名称=${item.name ?? '未命名'}`,
            colorText ? `颜色=${colorText}` : '',
            attrs ? `属性=${attrs}` : '',
          ]
            .filter(Boolean)
            .join('；');
        })
        .join('\n')
    : '（档案为空）';
  const scene = [
    `城市=${input.scene.city}`,
    `日期=${input.scene.day}`,
    `场合=${input.scene.scene}`,
    input.scene.temp
      ? `温度=${input.scene.temp}（${input.scene.tempSource === 'manual' ? '手动填写' : '实时天气'}）`
      : '',
    // B6：天气描述参与选择（晴/雨/雪等）；仅实时天气携带，手动温度无描述
    input.scene.tempSource === 'real' && input.scene.weatherDesc ? `天气=${input.scene.weatherDesc}` : '',
  ]
    .filter(Boolean)
    .join('，');
  const locked = input.lockedAliases?.length
    ? `\n\n用户当前搭配中已锁定的单品（候选组合必须包含）：${input.lockedAliases.join('、')}`
    : '';
  const prefsText = input.preferences?.length
    ? `\n\n用户长期偏好（参与排序与取舍，不是硬性约束）：${input.preferences.join('、')}`
    : '';
  const noteText = input.note?.trim()
    ? `\n\n本次要求（用户当次填写，优先满足；只作用于本次）：${input.note.trim().slice(0, 120)}`
    : '';
  const bodyText = buildBodyText(input.body);
  const profileNoteText = input.profileNote ? `\n\n${input.profileNote}` : '';
  return `我的衣物档案：\n${body}${profileNoteText}\n\n今天的情境：${scene}${bodyText}${locked}${prefsText}${noteText}\n\n请按 system 要求的 JSON 结构给出 2-3 个候选组合。`;
}

/** 身材资料行：仅在有有效数值时输出，明确"不下合身结论"的边界 */
function buildBodyText(input?: { heightCm?: number; weightKg?: number } | null): string {
  if (!input) return '';
  const parts = [
    typeof input.heightCm === 'number' && input.heightCm > 0 ? `身高=${input.heightCm}cm` : '',
    typeof input.weightKg === 'number' && input.weightKg > 0 ? `体重=${input.weightKg}kg` : '',
  ].filter(Boolean);
  return parts.length ? `\n\n用户身材资料（选填，仅作体型参考，不要给出合身结论）：${parts.join('，')}` : '';
}

/** 从模型返回内容解析推荐结果：整体 JSON / 剥 think / 单个围栏（与衣物分析同一套严格规则） */
export function parseRecommendationContent(content: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = content.trim();
  const thinkStripped = trimmed.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  for (const candidate of [trimmed, thinkStripped]) {
    if (candidate.startsWith('{') && candidate.endsWith('}')) {
      try {
        return { ok: true, value: JSON.parse(candidate) };
      } catch {
        /* 继续尝试围栏 */
      }
    }
  }
  for (const candidate of [trimmed, thinkStripped]) {
    const blocks = [...candidate.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)]
      .map((match) => (match[1] ?? '').trim())
      .filter((text) => text.startsWith('{') && text.endsWith('}'));
    if (blocks.length === 1) {
      try {
        return { ok: true, value: JSON.parse(blocks[0]) };
      } catch {
        return { ok: false, error: `围栏内容不是合法 JSON：${blocks[0].slice(0, 60)}` };
      }
    }
    if (blocks.length > 1) return { ok: false, error: `返回内容包含 ${blocks.length} 个代码块，无法确定结果` };
  }
  return { ok: false, error: `返回内容不是完整的 JSON 对象；开头：${trimmed.slice(0, 60) || '（空）'}` };
}

/** 手写归一化 + 校验：role 别名归一、wearStyle 白名单、结构完整；不引入新依赖。
 * B3（2026-11-04）：本地保证可执行性——重复单品/槽位、连衣裙与上下装冲突、
 * 锁定单品缺失都在此拒绝（提示词只能引导，不能代替校验）；
 * 包/配饰本期不支持（决定 D-1），出现即整体拒绝并说明。 */
export function normalizeRecommendation(
  value: unknown,
  idByAlias: ReadonlyMap<string, string>,
  options: { requireLockedAliases?: string[] } = {},
): { ok: true; value: RecommendationResult } | { ok: false; error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: '返回不是 JSON 对象' };
  }
  const raw = value as { candidates?: unknown; gaps?: unknown; summary?: unknown };
  if (!Array.isArray(raw.candidates) || raw.candidates.length === 0) {
    return { ok: false, error: 'candidates 缺失或为空' };
  }
  if (raw.candidates.length > 5) return { ok: false, error: 'candidates 超过 5 个' };

  const requiredLocks = [...new Set(options.requireLockedAliases ?? [])];
  const candidates: RecommendationCandidate[] = [];
  const seenCombos = new Set<string>();
  for (const candidate of raw.candidates) {
    const c = candidate as { slots?: unknown; wearStyle?: unknown; reason?: unknown };
    if (!c || typeof c !== 'object' || !Array.isArray(c.slots) || c.slots.length === 0) {
      return { ok: false, error: '候选缺少 slots' };
    }
    if (c.slots.length > 7) return { ok: false, error: '候选槽位超过 7 个' };
    const slots: RecommendationCandidate['slots'] = [];
    const aliasSet = new Set<string>();
    const roleSet = new Set<SlotRole>();
    for (const slot of c.slots) {
      const s = slot as { role?: unknown; itemId?: unknown; note?: unknown };
      if (!s || typeof s !== 'object') return { ok: false, error: '槽位格式错误' };
      const roleKey = typeof s.role === 'string' ? ROLE_ALIASES[s.role.toLowerCase()] : undefined;
      if (!roleKey) return { ok: false, error: `槽位 role 非法：${String(s.role)}` };
      if (roleKey === 'bag' || roleKey === 'accessory') {
        return { ok: false, error: '本期组合不支持包/配饰槽位（请只用上衣/下装/连衣裙/鞋履/外套）' };
      }
      if (roleSet.has(roleKey)) {
        return { ok: false, error: `候选内同一槽位出现多件：${roleKey}` };
      }
      const itemId = typeof s.itemId === 'string' ? s.itemId.trim() : '';
      if (!itemId) return { ok: false, error: '槽位缺少 itemId' };
      if (aliasSet.has(itemId)) return { ok: false, error: `候选内重复使用同一单品：${itemId.slice(0, 40)}` };
      // 别名 → 真实单品 ID；未知别名（模型幻觉）按缺失处理
      const realId = idByAlias.get(itemId);
      if (!realId) return { ok: false, error: `候选引用了档案外的单品：${itemId.slice(0, 40)}` };
      roleSet.add(roleKey);
      aliasSet.add(itemId);
      slots.push({
        role: roleKey,
        itemId: realId,
        ...(typeof s.note === 'string' && s.note.trim() ? { note: s.note.trim().slice(0, 120) } : null),
      });
    }
    if (roleSet.has('dress') && (roleSet.has('top') || roleSet.has('bottom'))) {
      return { ok: false, error: '连衣裙与上衣/下装不能同时出现在一个候选里' };
    }
    for (const locked of requiredLocks) {
      if (!aliasSet.has(locked)) {
        return { ok: false, error: `候选未包含锁定的单品：${locked.slice(0, 40)}` };
      }
    }
    const wearStyle = typeof c.wearStyle === 'string' ? c.wearStyle.trim() : '';
    if (!WEAR_STYLES.includes(wearStyle)) {
      return { ok: false, error: `wearStyle 非法：${wearStyle.slice(0, 30)}` };
    }
    // B4：相同单品集合（换顺序/换 note）不算新候选
    const comboKey = [...aliasSet].sort().join('|');
    if (seenCombos.has(comboKey)) continue;
    seenCombos.add(comboKey);
    candidates.push({
      slots,
      wearStyle: wearStyle,
      ...(typeof c.reason === 'string' && c.reason.trim() ? { reason: c.reason.trim().slice(0, 200) } : null),
    });
  }
  if (candidates.length === 0) {
    return { ok: false, error: '候选互为重复组合，没有可用的差异候选' };
  }

  const gaps = Array.isArray(raw.gaps)
    ? raw.gaps.filter((g): g is string => typeof g === 'string' && !!g.trim()).map((g) => g.trim().slice(0, 120)).slice(0, 8)
    : [];
  const summary = typeof raw.summary === 'string' && raw.summary.trim() ? raw.summary.trim().slice(0, 300) : undefined;
  return { ok: true, value: { candidates, gaps, ...(summary ? { summary } : null) } };
}

/** 输入指纹：单品集（别名排序）+ 场景（含温度来源）+ 身材资料 + 锁定集 + 长期偏好 + 当次要求 + 配置与提示词版本 */
export function buildRecommendationInputKey(input: {
  aliasItemIds: string[];
  scene: { city: string; day: string; scene: string; temp?: string; tempSource?: string; weatherDesc?: string };
  /** 身材资料（数值变化视为新输入）；缺省/null 与"未填写"等同 */
  body?: { heightCm?: number; weightKg?: number } | null;
  /** 锁定单品别名（排序后参与指纹，内容变化视为新输入） */
  lockedAliases?: string[];
  /** 长期偏好（排序后参与指纹） */
  preferences?: string[];
  /** 当次要求（参与指纹） */
  note?: string | null;
  configId: string;
  configRevision: string;
}): string {
  return JSON.stringify({
    itemIds: [...input.aliasItemIds].sort(),
    scene: input.scene,
    body: input.body ?? null,
    lockedAliases: [...(input.lockedAliases ?? [])].sort(),
    preferences: [...(input.preferences ?? [])].sort(),
    note: input.note?.trim() ? input.note.trim().slice(0, 120) : null,
    configId: input.configId,
    configRevision: input.configRevision,
    contractVersion: RECOMMENDATION_CONTRACT_VERSION,
    promptVersion: RECOMMENDATION_PROMPT_VERSION,
  });
}

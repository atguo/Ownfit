// 搭配推荐服务（M5 轨 B4）：提示词组装、模型返回解析与归一化、输入指纹。
// 纯函数，无 IO；提示词与 experiments 包 src/outfit-recommendation 同源（保持一致）。
// 红线：只用档案内单品（校验引用）；数据不足显式 gaps，不用不存在的单品凑数；
// 不输出合身/保暖等结论。

import { buildGarmentFeatureView } from './garmentView';

// 2026-11-04（评估 §8.2/§8.8）：提示词升 v5——属性带人工确认标记（A1 来源进提示词）、
// 日期带入队解析的具体日期（跨日不重新解释）、局部替换任务显式说明（F8）。
export const RECOMMENDATION_PROMPT_VERSION = '5';
export const RECOMMENDATION_CONTRACT_VERSION = 'outfit-recommendation-1';

/** B2 字符预算（§8.8，本地防御不宣称精确 token 限制）：档案行总长超限时先压缩次要层。
 * 与预览提示词预算（PREVIEW_PROMPT_BUDGET）同思路，按推荐档案规模单独取值。 */
export const RECOMMENDATION_PROMPT_BUDGET = 8000;

export interface ProfileItem {
  id: string;
  name: string | null;
  category: string | null;
  attributes: Array<{ name: string; value: string; /** A1：取值来源（user_confirmed/user_entered/ai_inferred），人工值在提示词标注 */ source?: string }>;
  colors: Array<{ name: string; hex: string; isPrimary?: boolean }>;
  /** A1/S1：资料版本（快照校验与输入指纹用；提示词不发送） */
  revision?: number;
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

/** 人工来源标记（人工确认/录入的值在提示词中标注，模型优先采信） */
export function isUserSource(source?: string): boolean {
  return source === 'user_confirmed' || source === 'user_entered';
}

/** 档案行（A2 归一化视图，2026-11-04）：与预览/核对同源的特征视图——
 * 品类/名称/主色/配色在前，关键特征居中，次要描述最后；
 * 人工确认值带（已确认）标记；未知不猜填。推荐入队预算与提示词共用同一份行，
 * 预算压缩（去次要层）不会让行内容与提示词漂移。 */
export function profileLines(items: ProfileItem[]): string[] {
  return items.map((item) => {
    const view = buildGarmentFeatureView({
      category: item.category,
      colors: item.colors.map((c) => ({ name: c.name, hex: c.hex, isPrimary: c.isPrimary })),
      // 已确认标记并入 value：关键/次要两层都保留来源标记
      attributes: item.attributes.map((a) => ({
        name: a.name,
        value: `${a.value}${isUserSource(a.source) ? '（已确认）' : ''}`,
      })),
    });
    const parts = [
      `- id=${item.id}`,
      `品类=${item.category ?? '未知'}`,
      `名称=${item.name ?? '未命名'}`,
      view.mainColor ? `主色=${view.mainColor.name}` : '',
      view.accentColorNames.length ? `配色=${view.accentColorNames.join('/')}` : '',
      view.keyFeatures.length ? view.keyFeatures.join('，') : '',
      view.secondary.length ? `细节：${view.secondary.join('，')}` : '',
    ].filter(Boolean);
    return parts.join('；');
  });
}

/** 品类 → 组合槽位（服务层槽位名；与 features/outfitSession 的 slotForCategory 同语义，
 * 外套在服务层称 outerwear。无法映射的品类（包/配饰）返回 null）。 */
export function categoryToSlotRole(category: string | null): SlotRole | null {
  switch (category) {
    case '上衣':
      return 'top';
    case '下装':
      return 'bottom';
    case '连衣裙':
      return 'dress';
    case '鞋履':
      return 'shoes';
    case '外套':
      return 'outerwear';
    default:
      return null;
  }
}

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
  scene: {
    city: string;
    day: string;
    scene: string;
    temp?: string;
    tempSource?: string;
    weatherDesc?: string;
    /** 入队解析的具体日期（yyyy-MM-dd）；缺失按旧口径只显示 label（历史任务回退） */
    targetDate?: string;
  };
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
  /** F8 局部替换任务的显式说明（只换目标槽位、其余保持） */
  replacementNote?: string;
}): string {
  const lines = profileLines(input.items);
  const body = lines.length ? lines.join('\n') : '（档案为空）';
  const scene = [
    `城市=${input.scene.city}`,
    // 日期带入队解析的具体日期：跨日执行不重新解释"今天/明天"（评估 §8.6）
    `日期=${input.scene.targetDate ? `${input.scene.targetDate}（${input.scene.day}）` : input.scene.day}`,
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
  const replacement = input.replacementNote ? `\n\n${input.replacementNote}` : '';
  const prefsText = input.preferences?.length
    ? `\n\n用户长期偏好（参与排序与取舍，不是硬性约束）：${input.preferences.join('、')}`
    : '';
  const noteText = input.note?.trim()
    ? `\n\n本次要求（用户当次填写，优先满足；只作用于本次）：${input.note.trim().slice(0, 120)}`
    : '';
  const bodyText = buildBodyText(input.body);
  const profileNoteText = input.profileNote ? `\n\n${input.profileNote}` : '';
  return `我的衣物档案：\n${body}${profileNoteText}\n\n今天的情境：${scene}${bodyText}${locked}${replacement}${prefsText}${noteText}\n\n请按 system 要求的 JSON 结构给出 2-3 个候选组合。`;
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
 * 包/配饰本期不支持（决定 D-1），出现即整体拒绝并说明。
 * F8（评估 §8.2.5）：局部替换模式（options.replacement）——其他件必须原样保留，
 * 只允许目标槽位换成档案内品类一致的替代件；新增基线外槽位/改动保留件都拒绝。 */
export function normalizeRecommendation(
  value: unknown,
  idByAlias: ReadonlyMap<string, string>,
  options: {
    requireLockedAliases?: string[];
    /** 别名 → 品类（快照内已知品类时校验"真实品类与 role 一致"，§8.2.5） */
    categoryByAlias?: ReadonlyMap<string, string>;
    /** 局部替换约束（F8）；提供时逐候选校验可变范围 */
    replacement?: {
      lockedAliases: string[];
      targetRole: SlotRole;
      baselineRoles: Partial<Record<SlotRole, string>>;
    };
  } = {},
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
  const replacement = options.replacement;
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
      // 品类与 role 一致（§8.2.5）：快照内品类已知时，模型声明的槽位必须与真实品类相符
      const category = options.categoryByAlias?.get(itemId);
      if (category) {
        const expectedRole = categoryToSlotRole(category);
        if (expectedRole && expectedRole !== roleKey) {
          return { ok: false, error: `候选把「${category}」放进了不符的槽位：${roleKey}` };
        }
        if (!expectedRole) {
          return { ok: false, error: `候选包含本期不支持的品类：${category}` };
        }
      }
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
    // F8 局部替换：槽位集合 = 锁定槽位（原样）+ 目标槽位（可换成替代件），不得新增其他槽位
    if (replacement) {
      const lockedAliasSet = new Set(replacement.lockedAliases);
      for (const [role, alias] of Object.entries(replacement.baselineRoles) as [SlotRole, string][]) {
        if (role === replacement.targetRole || lockedAliasSet.has(alias)) continue;
        if (!aliasSet.has(alias)) {
          return { ok: false, error: `候选改动了应保持不变的单品：${alias.slice(0, 40)}` };
        }
        const slotByAlias = slots.find((slot) => slot.itemId === idByAlias.get(alias));
        if (!slotByAlias || slotByAlias.role !== role) {
          return { ok: false, error: `候选改变了应保持槽位的单品角色：${alias.slice(0, 40)}` };
        }
      }
      for (const [alias, role] of [...aliasSet].map((alias) => [alias, roleSetOf(slots, alias, idByAlias)] as const)) {
        if (role === replacement.targetRole) continue;
        if (lockedAliasSet.has(alias)) continue;
        return { ok: false, error: `局部替换不允许新增或改换槽位：${role}（${alias.slice(0, 40)}）` };
      }
      if (!roleSet.has(replacement.targetRole)) {
        return { ok: false, error: '局部替换候选缺少目标槽位的替代单品' };
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

/** 局部替换校验辅助：别名在候选中的槽位角色 */
function roleSetOf(
  slots: RecommendationCandidate['slots'],
  alias: string,
  idByAlias: ReadonlyMap<string, string>,
): SlotRole | null {
  const realId = idByAlias.get(alias);
  const found = slots.find((slot) => slot.itemId === realId);
  return found?.role ?? null;
}

/** 输入指纹：已迁移到 services/ai/recommendationInput.ts 的 buildRecommendationInputKeyV2
 * （评估 §8.2.3：真实 ID+版本+基线+允许变化槽位+场景具体日期全部纳入，规范化序列化）。
 * 旧别名版指纹已删除——无真实映射的旧入队路径不再存在。 */

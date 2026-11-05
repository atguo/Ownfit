// A3 按用途检查衣物证据（建议稿 A3，2026-11-04；§8.8 补齐 targetStatus/unclearParts/文件可读性）：
// 复用 targetStatus/主图/有效视图，判断一件衣物"可以参与粗筛/可以复核外观/具备预览输入"，
// 只对当前选中或锁定的单品提出关键补充，不做全柜扫描拦截（决策 D-11）。
// 规则：缺背面不阻断正面搭配；未知不当作违反约束；质量检查失败仍保留草稿；
// 多单品图/遮挡是"依据较少"的提示（可跳过），不是拦截条件。

import { File, Paths } from 'expo-file-system';
import { getItem } from '../../data/repositories/itemRepository';
import { getAnalysisView } from '../../data/repositories/attributeRepository';
import { getMainPhotoPaths } from '../../data/repositories/photoRepository';

export interface GarmentEvidenceStatus {
  itemId: string;
  name: string;
  /** 有可用主图（外观复核的基础） */
  hasPhoto: boolean;
  /** 主图文件实际可读（记录在但文件丢失时如实区分） */
  photoReadable: boolean;
  /** 有任何已提取属性（AI 或人工） */
  hasAnalysis: boolean;
  /** 可参与粗筛：品类已确认 */
  usableForCoarseFilter: boolean;
  /** 可复核外观：有主图 */
  usableForAppearanceReview: boolean;
  /** 具备预览输入：有主图且有描述依据（属性或颜色） */
  usableForPreviewInput: boolean;
  /** 面向用户的缺失说明（可跳过；一次只提最关键的一项） */
  missing: string[];
}

export async function checkGarmentEvidence(itemId: string): Promise<GarmentEvidenceStatus | null> {
  const item = await getItem(itemId);
  if (!item || item.status !== 'active') return null;
  const [view, paths] = await Promise.all([getAnalysisView(itemId), getMainPhotoPaths(itemId)]);
  const hasPhoto = !!paths;
  // §8.8 A3：记录在但文件读不到时如实区分（不冒充"有照片"）
  const photoReadable = !!paths && new File(Paths.document, paths.originalPath).exists;
  const hasAnalysis = view.attributes.length > 0 || view.colors.value.length > 0;
  const usableForCoarseFilter = !!view.category.value;
  const usableForPreviewInput = hasPhoto && (hasAnalysis || !!view.category.value);
  // 最近一次有效分析的目标判定与遮挡部位（非 single 时不生成视图内容，只作证据提示）
  const targetStatus = view.lastValidResult?.result.targetStatus ?? null;
  const unclearParts = view.lastValidResult?.result.unclearParts ?? [];

  const missing: string[] = [];
  if (!usableForCoarseFilter) {
    missing.push('还没确认品类，先在衣物详情里确认后即可参与搭配');
  } else if (!hasPhoto) {
    missing.push('还没有可用照片，无法复核外观');
  } else if (!photoReadable) {
    missing.push('照片文件读不到（可能被清理），请重新拍一张或从相册补图');
  } else if (targetStatus && targetStatus !== 'single') {
    missing.push('最近一次分析判断这张照片里不止一件衣物；预览还原依据较少，建议补一张单件清晰照（不阻断）');
  } else if (!hasAnalysis) {
    missing.push('还没有分析结果，预览的还原依据较少（可先手动补几条关键特征）');
  } else if (unclearParts.length) {
    missing.push(`照片里这些部位看不清：${unclearParts.slice(0, 2).join('、')}（不影响先用）`);
  }

  return {
    itemId,
    name: item.name ?? view.suggestedName?.value ?? '未命名',
    hasPhoto,
    photoReadable,
    hasAnalysis,
    usableForCoarseFilter,
    usableForAppearanceReview: hasPhoto,
    usableForPreviewInput,
    missing,
  };
}

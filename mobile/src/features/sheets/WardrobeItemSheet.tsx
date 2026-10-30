// 真实单品详情与编辑（字段来源重构版）：
// - 动态属性行全展示：`名称：值` + 三色来源徽章 + 删除；按品类推荐键排序
// - AI 名称建议/颜色（hex 色块）可采纳确认；测量可空可填（仅用户录入）
// - AI 结果按"人工优先"展示：人工确认值优先，AI 不同建议只作提示
// 规则依据分批执行手册 R2/R5 与衣橱功能文档；未知显式表达不冒充。

import { useCallback, useEffect, useState } from 'react';
import { Alert, Image, StyleSheet, Text, View } from 'react-native';
import { Sheet } from '../../ui/components/Sheet';
import { Button } from '../../ui/components/Button';
import { Field, TextField } from '../../ui/components/Field';
import { useToast } from '../../ui/components/Toast';
import {
  archiveItem,
  confirmItem,
  getItem,
  purgeItem,
  restoreItem,
  updateItemBasics,
  type WardrobeItem,
} from '../../data/repositories/itemRepository';
import {
  deleteAttribute,
  getAnalysisView,
  recordUserAttribute,
  setMeasurements,
} from '../../data/repositories/attributeRepository';
import {
  type AnalysisView,
  type AttrSource,
  type DynamicAttribute,
  type Measurement,
} from '../../data/repositories/analysisTypes';
import type { ModelConfig } from '../../services/ai/types';
import {
  createActionId,
  getPendingAnalysisCommitCount,
  initGarmentTaskRunner,
  notifyAnalysisChanged,
  notifyAnalysisDbChanged,
  requestKeyFor,
  rememberDefaultVisionConfig,
  resolveVisionForAnalysis,
  retryPendingAnalysisCommits,
  subscribeAnalysisChanges,
} from '../../features/garmentAnalysisStore';
import { addToColorLibrary } from '../../data/repositories/colorLibraryRepository';
import { categories, type ItemCategory } from '../../data/demo';
import { colors, radius, type } from '../../ui/tokens';

export interface WardrobeItemDetail {
  item: WardrobeItem;
  /** 详情展示用原图 */
  originalUri: string | null;
}

/** 每品类的常用测量名（重构设计 §7） */
const MEASUREMENT_SUGGESTIONS: Partial<Record<ItemCategory, readonly string[]>> = {
  上衣: ['肩宽', '胸围', '衣长', '袖长'],
  外套: ['肩宽', '胸围', '衣长', '袖长'],
  下装: ['腰围', '臀围', '裤长', '裙长'],
  连衣裙: ['胸围', '腰围', '裙长'],
  鞋履: ['内长'],
  包: ['长', '宽', '高'],
};

/** 本地时区的 yyyy-MM-dd HH:mm（ISO 字符串是 UTC，直接截取会差 8 小时） */
function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 来源三色徽章文字与色值（重构设计 §6） */
function sourceBadge(source: AttrSource): { text: string; color: string } {
  switch (source) {
    case 'user_confirmed':
      return { text: '已确认', color: colors.tagText };
    case 'user_entered':
      return { text: '手动录入', color: colors.green };
    default:
      return { text: 'AI 推断', color: colors.muted };
  }
}

export function WardrobeItemSheet({
  detail,
  onClose,
  onChanged,
  onUse,
}: {
  detail: WardrobeItemDetail | null;
  onClose: () => void;
  /** 条目发生变化（入库/编辑/归档/删除）后回调，列表刷新 */
  onChanged: () => void;
  /** 已入库单品：围绕这件搭配（进入搭配会话） */
  onUse: (id: string) => void;
}) {
  const toast = useToast();
  const item = detail?.item;
  const [name, setName] = useState('');
  const [category, setCategory] = useState<ItemCategory | undefined>();

  const [analysis, setAnalysis] = useState<AnalysisView | null>(null);
  const [modelCandidates, setModelCandidates] = useState<ModelConfig[] | null>(null);
  const [attrEditing, setAttrEditing] = useState<{ name: string; value: string } | null>(null);
  const [newAttr, setNewAttr] = useState<{ name: string; value: string } | null>(null);
  const [measurementAdd, setMeasurementAdd] = useState<{
    name: string;
    amount: string;
    unit: 'cm' | 'mm';
    note: string;
  } | null>(null);

  const itemId = item?.id ?? null;
  const itemUpdatedAt = item?.updatedAt;

  // 每次打开时按当前条目回填
  useEffect(() => {
    if (item) {
      setName(item.name ?? '');
      setCategory(item.category ?? undefined);
    }
    setAttrEditing(null);
    setNewAttr(null);
    setMeasurementAdd(null);
  }, [item?.id, itemUpdatedAt]);

  const loadAnalysis = useCallback(async (id: string) => {
    setAnalysis(await getAnalysisView(id));
  }, []);

  useEffect(() => {
    if (!itemId) {
      setAnalysis(null);
      return;
    }
    void loadAnalysis(itemId);
    // 任务/属性在后台变化时刷新展示，但不改动用户正在编辑的字段
    return subscribeAnalysisChanges(() => {
      void loadAnalysis(itemId);
    });
  }, [itemId, loadAnalysis]);

  const isDraft = item?.status === 'draft';
  const isArchived = item?.status === 'archived';
  const pendingCommits = getPendingAnalysisCommitCount();
  const nameAdopted = !!analysis?.suggestedName?.value && name === analysis.suggestedName.value;
  const aiAttributeCount = analysis?.attributes.filter((a) => a.source === 'ai_inferred').length ?? 0;

  function statusText(view: AnalysisView): string {
    const task = view.latestTask;
    if (!task) return '尚未分析';
    switch (task.status) {
      case 'queued':
        return '已排队，等待开始';
      case 'running':
        return '正在分析…';
      case 'succeeded':
        return view.lastValidResult
          ? `上次分析完成（${formatTime(view.lastValidResult.completedAt)}，模型：${view.lastValidResult.modelName}）`
          : '照片不够清楚，建议换成更清晰的单品照后再试';
      case 'failed':
        return task.errorSummary ? `上次分析失败：${task.errorSummary}` : '上次分析失败，可重试';
      case 'interrupted':
        return task.errorSummary
          ? `上次分析被中断（${task.errorSummary}）；重试可能再次计费`
          : '上次分析被中断，结果未知；重试可能再次计费';
      case 'stale':
        return '这件资料已更新，上次结果不再适用于当前照片';
      case 'blocked':
        return task.errorSummary ?? '所选模型配置已变化或不可用，请重新选择后再分析';
      case 'cancelled':
        return '上次分析已取消（衣物归档或资料删除后不再继续）';
      default:
        return '尚未分析';
    }
  }

  async function saveBasics() {
    if (!item) return;
    await updateItemBasics(item.id, { name, category: category ?? undefined });
    onChanged();
    toast('已保存');
  }

  /** 采纳 AI 名称建议：写入单品名称并同步名称输入框（不同步的话“保存修改”会用旧名覆盖） */
  async function adoptSuggestedName() {
    if (!item) return;
    const suggestion = analysis?.suggestedName?.value?.trim();
    if (!suggestion) return;
    try {
      await updateItemBasics(item.id, { name: suggestion });
      setName(suggestion);
      toast('已采纳为单品名称');
      onChanged();
    } catch {
      toast('采纳失败，请重试');
    }
  }

  async function confirmDraft() {
    if (!item || !category) {
      toast('请先选择品类');
      return;
    }
    await confirmItem(item.id, { category, name });
    onChanged();
    onClose();
    toast('已入库，尺寸和细节以后再补');
  }

  /** 排队一次分析（手动）；模型未就绪时按缺失/无效/需选择分别处理 */
  async function startAnalysis() {
    if (!item) return;
    const runner = initGarmentTaskRunner();
    const resolution = await resolveVisionForAnalysis();
    if (resolution.status === 'choose') {
      setModelCandidates(resolution.candidates);
      return;
    }
    if (resolution.status !== 'ready') {
      Alert.alert('暂不能分析', resolution.status === 'missing' ? '还没有可用于图片理解的模型配置。' : resolution.message, [
        { text: '知道了', style: 'cancel' },
        { text: '去配置', onPress: onClose },
      ]);
      return;
    }
    const actionId = createActionId();
    const task = await runner.enqueueGarmentAnalysis({
      itemId: item.id,
      configId: resolution.config.id,
      trigger: 'manual',
      requestKey: requestKeyFor(actionId, item.id),
    });
    notifyAnalysisDbChanged();
    if (task.status === 'rejected') {
      toast(task.reason === 'photo_missing' ? '这件没有可用主图，先换一张照片再分析' : '暂时无法开始分析');
    } else {
      toast('已开始分析');
    }
  }

  /** 失败/中断后的重试：明确提示结果未知且可能再次计费 */
  function retryAnalysis() {
    Alert.alert('重试分析？', '上次结果未知（可能已被服务受理）。重试会再次调用你配置的模型，可能再次计费。', [
      { text: '取消', style: 'cancel' },
      { text: '仍然重试', onPress: () => void startAnalysis() },
    ]);
  }

  async function selectModel(configId: string) {
    setModelCandidates(null);
    await rememberDefaultVisionConfig(configId);
    await startAnalysis();
  }

  /** 只把内存中的结果重试保存到本机，不重新调用模型 */
  async function retrySave() {
    await retryPendingAnalysisCommits();
    if (item) await loadAnalysis(item.id);
    toast('已重试保存本机结果');
  }

  /** 确认一条属性：AI 推断 → 用户确认（不再被覆盖）；颜色确认同时并入颜色库 */
  async function confirmAttribute(name: string, value: string) {
    if (!item) return;
    await recordUserAttribute({
      itemId: item.id,
      field: name,
      value,
      sourceType: 'user_confirmed',
      sourceRef: '详情确认分析结果',
    });
    if (name === '颜色') {
      const { getColorLibrary, addToColorLibrary } = await import(
        '../../data/repositories/colorLibraryRepository'
      );
      const library = await getColorLibrary();
      const hexes = new Set(library.map((entry) => entry.hex));
      const analysisColors = analysis?.colors.value ?? [];
      const newColors = analysisColors.filter((color) => !hexes.has(color.hex));
      if (newColors.length > 0) await addToColorLibrary(newColors);
    }
    await loadAnalysis(item.id);
    notifyAnalysisChanged();
    onChanged();
  }

  /** 一键确认：全部 AI 推断属性行写入用户确认（逐条写 user_confirmed，不再被后续同名 AI 行顶掉显示来源） */
  async function confirmAllAiAttributes() {
    if (!item || !analysis) return;
    const aiRows = analysis.attributes.filter((attribute) => attribute.source === 'ai_inferred');
    if (aiRows.length === 0) return;
    try {
      for (const attribute of aiRows) {
        await recordUserAttribute({
          itemId: item.id,
          field: attribute.name,
          value: attribute.value,
          sourceType: 'user_confirmed',
          sourceRef: '一键确认分析结果',
        });
      }
      await loadAnalysis(item.id);
      notifyAnalysisChanged();
      onChanged();
      toast(`已确认 ${aiRows.length} 项`);
    } catch {
      toast('确认失败，请重试');
    }
  }

  /** 删除一条属性行（物理删除 + revision 递增） */
  async function removeAttribute(name: string) {
    if (!item) return;
    await deleteAttribute(item.id, name);
    await loadAnalysis(item.id);
    notifyAnalysisChanged();
    onChanged();
    toast(`已删除「${name}」`);
  }

  /** 添加自定义属性（手动录入） */
  async function addCustomAttribute() {
    if (!item || !newAttr) return;
    const attrName = newAttr.name.trim();
    const attrValue = newAttr.value.trim();
    if (!attrName || !attrValue) {
      toast('属性名和值都需要填写');
      return;
    }
    await recordUserAttribute({
      itemId: item.id,
      field: attrName,
      value: attrValue,
      sourceType: 'user_entered',
      sourceRef: '详情手动添加',
    });
    setNewAttr(null);
    await loadAnalysis(item.id);
    notifyAnalysisChanged();
    onChanged();
    toast('已添加');
  }

  /** 测量列表：追加一条（单位默认 cm；鞋履建议 mm） */
  function addMeasurement(name: string, amount: string, unit: 'cm' | 'mm', note?: string) {
    if (!item) return;
    const current = analysis?.measurements?.list ?? [];
    const next = [...current, { name, amount, unit, note }];
    void setMeasurements(item.id, next);
    setMeasurementAdd(null);
  }

  function removeMeasurement(index: number) {
    if (!item) return;
    const current = analysis?.measurements?.list ?? [];
    void setMeasurements(item.id, current.filter((_entry, i) => i !== index));
  }

  function archive() {
    if (!item) return;
    void archiveItem(item.id).then(() => {
      notifyAnalysisDbChanged();
      onChanged();
      onClose();
      toast('已归档，可在衣橱"已归档"里找回');
    });
  }

  function restore() {
    if (!item) return;
    void restoreItem(item.id).then(() => {
      onChanged();
      onClose();
      toast('已恢复到衣橱');
    });
  }

  function purge() {
    if (!item) return;
    const label = item.name ?? '这件衣服';
    Alert.alert('彻底删除？', `"${label}" 的资料、分析结果及照片将从本机永久删除，无法恢复。历史搭配和穿着记录会保留，并将这件衣物标记为"已删除"。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '彻底删除',
        style: 'destructive',
        onPress: async () => {
          try {
            await purgeItem(item.id);
            notifyAnalysisDbChanged();
            onChanged();
            onClose();
            toast('已删除，历史搭配保留已删除标记');
          } catch {
            notifyAnalysisDbChanged();
            onChanged();
            Alert.alert('删除未全部完成', '衣物可能已标记删除，但照片清理尚未完成。请重试。', [
              { text: '稍后', onPress: onClose },
              { text: '重试', onPress: purge },
            ]);
          }
        },
      },
    ]);
  }

  const hasValidResult = analysis?.lastValidResult != null;
  const canRetryAnalysis =
    analysis?.latestTask?.status === 'failed' ||
    analysis?.latestTask?.status === 'interrupted' ||
    analysis?.latestTask?.status === 'stale' ||
    analysis?.latestTask?.status === 'blocked';

  return (
    <Sheet visible={item != null} title={item?.name ?? '单品详情'} onClose={onClose}>
      {item ? (
        <>
          {isDraft ? <Text style={styles.statusNote}>草稿 · 确认品类后入库</Text> : null}
          {isArchived ? <Text style={styles.statusNote}>已归档 · 不出现在衣橱列表</Text> : null}

          {detail?.originalUri ? (
            <Image
              source={{ uri: detail.originalUri }}
              style={styles.photo}
              resizeMode="cover"
              accessibilityLabel={item.name ?? '单品照片'}
            />
          ) : null}

          <Field label="名称（可选）">
            <TextField value={name} onChangeText={setName} maxLength={30} placeholder="给它一个名字" />
          </Field>

          <Field label="品类（必选）">
            <View style={styles.chipRow}>
              {categories.map((option) => (
                <Button
                  key={option}
                  variant="chip"
                  label={option}
                  active={category === option}
                  onPress={() => setCategory(option)}
                />
              ))}
            </View>
          </Field>

          {isDraft ? (
            <Button variant="primary" label="确认入库" onPress={confirmDraft} />
          ) : (
            <>
              <Button variant="primary" label="围绕这件搭配" onPress={() => item && onUse(item.id)} />
              <Button variant="secondary" label="保存修改" onPress={saveBasics} style={styles.gap} />
            </>
          )}

          {!isDraft && analysis ? (
            <View style={styles.analysisBlock}>
              <Text style={styles.sectionTitle}>照片分析</Text>
              <Text style={styles.statusNote}>{statusText(analysis)}</Text>

              {modelCandidates ? (
                <View style={styles.modelChooser}>
                  <Text style={styles.sourceNote}>有多个可用的图片理解模型，选择一个（会记住）：</Text>
                  {modelCandidates.map((config) => (
                    <Button
                      key={config.id}
                      variant="chip"
                      label={`${config.name} · ${config.modelId}`}
                      onPress={() => void selectModel(config.id)}
                      style={styles.modelOption}
                    />
                  ))}
                </View>
              ) : null}

              {/* AI 名称建议：采纳后写入单品名称；当前名称与建议一致即视为已采纳（重开详情同样生效） */}
              {analysis.suggestedName?.value ? (
                <View style={styles.attributeRow}>
                  <View style={styles.attributeText}>
                    <Text style={styles.attributeName}>名称建议</Text>
                    <Text style={styles.attributeValue}>{analysis.suggestedName.value}</Text>
                    <Text style={[styles.sourceText, { color: colors.muted }]}>
                      {nameAdopted ? '已采纳为单品名称' : 'AI 推断（未确认）'}
                    </Text>
                  </View>
                  <Button
                    variant="chip"
                    label={nameAdopted ? '已采纳' : '采纳'}
                    disabled={nameAdopted}
                    onPress={() => void adoptSuggestedName()}
                  />
                </View>
              ) : null}

              {pendingCommits > 0 ? (
                <>
                  <Text style={styles.sourceNote}>
                    有 {pendingCommits} 条分析结果还没保存到本机（保存失败）。重试保存不会再调用模型。
                  </Text>
                  <Button variant="secondary" label="重试保存结果" onPress={() => void retrySave()} style={styles.gap} />
                </>
              ) : null}

              {canRetryAnalysis ? (
                <Button
                  variant="secondary"
                  label="重试分析…"
                  onPress={retryAnalysis}
                  style={styles.gap}
                />
              ) : (
                <Button
                  variant="secondary"
                  label={hasValidResult || analysis.latestTask ? '重新分析' : 'AI 分析'}
                  onPress={() => void startAnalysis()}
                  style={styles.gap}
                />
              )}

              {analysis.attributes.length > 0 ? (
                <Text style={styles.sourceNote}>
                  以下 {analysis.attributes.length} 项来自照片分析，可逐条确认或删除：
                </Text>
              ) : null}
              {aiAttributeCount > 0 ? (
                <Button
                  variant="secondary"
                  label={`一键确认全部 AI 推断（${aiAttributeCount} 项）`}
                  onPress={() => void confirmAllAiAttributes()}
                  style={styles.gap}
                />
              ) : null}
              {analysis.attributes.map((attribute) => (
                <AttributeRowView
                  key={attribute.name}
                  attribute={attribute}
                  onConfirm={() =>
                    void confirmAttribute(attribute.name, attribute.value).then(() => undefined)
                  }
                  onDelete={() => void removeAttribute(attribute.name)}
                />
              ))}

              {/* 测量区：替代静态"未填写" */}
              <Text style={styles.sectionTitle}>实测尺寸</Text>
              {(analysis.measurements?.list ?? []).length === 0 ? (
                <Text style={styles.sourceNote}>还没有测量记录。按需填写，可留空。</Text>
              ) : (
                (analysis.measurements?.list ?? []).map((measurement, index) => (
                  <View key={`${measurement.name}-${index}`} style={styles.measurementRow}>
                    <Text style={styles.measurementText}>
                      {measurement.name}：{measurement.amount} {measurement.unit}
                      {measurement.note ? `（${measurement.note}）` : ''}
                    </Text>
                    <Button variant="chip" label="删除" onPress={() => removeMeasurement(index)} />
                  </View>
                ))
              )}
              <MeasurementAddForm
                suggestions={MEASUREMENT_SUGGESTIONS[item.category as keyof typeof MEASUREMENT_SUGGESTIONS] ?? []}
                onSave={(name, amount, unit, note) => {
                  addMeasurement(name, amount, unit, note);
                }}
              />
            </View>
          ) : null}

          {isDraft ? null : isArchived ? (
            <Button variant="secondary" label="恢复到衣橱" onPress={restore} style={styles.gap} />
          ) : (
            <Button variant="secondary" label="归档（可恢复）" onPress={archive} style={styles.gap} />
          )}
          <Button variant="text" label="彻底删除…" onPress={purge} />
        </>
      ) : null}
    </Sheet>
  );
}

function AttributeRowView({
  attribute,
  onConfirm,
  onDelete,
}: {
  attribute: DynamicAttribute;
  onConfirm: () => void;
  onDelete: () => void;
}) {
  const badge = sourceBadge(attribute.source);
  return (
    <View style={styles.attributeRow}>
      <View style={styles.attributeText}>
        <Text style={styles.attributeName}>{attribute.name}</Text>
        <Text style={styles.attributeValue}>{attribute.value}</Text>
        <Text style={[styles.sourceText, { color: badge.color }]}>{badge.text}</Text>
      </View>
      {attribute.source === 'ai_inferred' ? (
        <Button variant="chip" label="确认" onPress={onConfirm} />
      ) : null}
      <Button variant="chip" label="删除" onPress={onDelete} />
    </View>
  );
}


function MeasurementAddForm({
  suggestions,
  onSave,
}: {
  suggestions: readonly string[];
  onSave: (name: string, amount: string, unit: 'cm' | 'mm', note?: string) => void;
}) {
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [unit, setUnit] = useState<'cm' | 'mm'>('cm');
  const [note, setNote] = useState('');

  return (
    <View style={styles.measurementForm}>
      <Field label="测量名称">
        <TextField value={name} onChangeText={setName} placeholder="如：衣长（也可自定义）" maxLength={20} />
      </Field>
      {suggestions.length > 0 ? (
        <View style={styles.chipRow}>
          {suggestions.map((suggestion) => (
            <Button key={suggestion} variant="chip" label={suggestion} onPress={() => setName(suggestion)} />
          ))}
        </View>
      ) : null}
      <Field label="数值与单位">
        <View style={styles.amountRow}>
          <TextField value={amount} onChangeText={setAmount} placeholder="如：62" keyboardType="numeric" style={styles.amountInput} />
          <Button variant="chip" label="cm" active={unit === 'cm'} onPress={() => setUnit('cm')} />
          <Button variant="chip" label="mm" active={unit === 'mm'} onPress={() => setUnit('mm')} />
        </View>
      </Field>
      <Button
        variant="secondary"
        label="保存这条测量"
        disabled={!name.trim() || !amount.trim()}
        onPress={() => onSave(name.trim(), amount.trim(), unit)}
        style={styles.gap}
      />
      <Text style={styles.sourceNote}>测量仅由你录入；AI 不会从照片猜测尺寸。</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  cellLabel: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 5,
  },
  cellValue: {
    color: colors.ink,
    fontSize: 12,
    lineHeight: 18,
  },
  photo: {
    width: 150,
    height: 150,
    alignSelf: 'center',
    marginTop: 10,
    marginBottom: 16,
    borderRadius: radius.buttonLg,
    backgroundColor: colors.artBg,
  },
  statusNote: {
    fontSize: 12,
    lineHeight: 18,
    color: colors.muted,
    marginBottom: 10,
  },
  sectionTitle: {
    ...type.heading,
    color: colors.ink,
    marginTop: 18,
    marginBottom: 6,
  },
  analysisBlock: {
    marginTop: 6,
  },
  sourceNote: {
    ...type.footnote,
    color: colors.muted,
    lineHeight: 18,
    marginBottom: 6,
  },
  sourceText: {
    fontSize: 10,
    lineHeight: 14,
  },
  modelChooser: {
    marginBottom: 10,
  },
  modelOption: {
    marginTop: 6,
    alignSelf: 'flex-start',
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 8,
  },
  attributeRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  attributeText: {
    flex: 1,
    minWidth: 0,
  },
  attributeName: {
    color: colors.ink,
    fontSize: 12,
    fontWeight: '500',
    lineHeight: 18,
  },
  attributeValue: {
    color: colors.ink,
    fontSize: 12,
    lineHeight: 18,
  },
  measurementRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  measurementText: {
    flex: 1,
    minWidth: 0,
    color: colors.ink,
    fontSize: 12,
    lineHeight: 18,
  },
  measurementForm: {
    marginTop: 6,
  },
  amountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  amountInput: {
    flex: 1,
  },
  gap: {
    alignSelf: 'stretch',
    marginTop: 10,
  },
});

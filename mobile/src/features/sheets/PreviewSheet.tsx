// 上身预览面板（M5 轨 A3）：从当前搭配会话发起生成，展示任务状态、结果图与历史。
// 诚实边界：AI 生成示意图 ≠ 真实试穿；方案变化后的旧预览明确标注，不冒充当前方案结果。

import { useCallback, useEffect, useState } from 'react';
import { Alert, Image, StyleSheet, Text, View } from 'react-native';
import { Sheet } from '../../ui/components/Sheet';
import { Button } from '../../ui/components/Button';
import { Notice, Tag } from '../../ui/components/Basics';
import { useToast } from '../../ui/components/Toast';
import {
  enqueuePreview,
  loadCurrentPreviewInput,
  loadLatestPreviewCheck,
  loadLatestPreviewPostProcess,
  rememberDefaultImageGenConfig,
  resolveImageGenForPreview,
  retryPreviewSave,
  subscribePreviewChanges,
} from '../previewStore';
import {
  createPreviewComparison,
  deletePreviewTask,
  listRecentPreviewTasks,
  previewImageUri,
  previewInputMatches,
  type PreviewTask,
} from '../../data/repositories/previewRepository';
import type { PreviewCheckRecord, PreviewCheckOverall } from '../../data/repositories/previewCheckRepository';
import type { PreviewPostProcessRecord } from '../../data/repositories/previewPostprocessRepository';
import type { ConfigResolution } from '../../services/ai/visionConfig';
import { checkGarmentEvidence } from '../../services/ai/evidenceCheck';
import { callRevisionOf } from '../../services/ai/types';
import { colors, type } from '../../ui/tokens';

/** 本地时区 yyyy-MM-dd HH:mm（finishedAt 是 UTC ISO，直接截取差 8 小时） */
function formatLocal(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 终态任务可删除；queued/running 不提供（任务完成后自然可删） */
function isDeletable(task: PreviewTask): boolean {
  return (
    task.status === 'succeeded' ||
    task.status === 'failed' ||
    task.status === 'interrupted' ||
    task.status === 'blocked' ||
    task.status === 'stale' ||
    task.status === 'cancelled'
  );
}

function statusLine(task: PreviewTask): string {
  switch (task.status) {
    case 'queued':
      return '排队中…';
    case 'running':
      return '生成中…（约 1-2 分钟）';
    case 'succeeded':
      return `生成完成 ${task.finishedAt ? formatLocal(task.finishedAt) : ''}`;
    case 'failed':
      return `生成失败：${task.errorSummary ?? '未知原因'}`;
    case 'interrupted':
      return '结果未知（可能超时或断网），可重试';
    case 'blocked':
      return task.errorSummary ?? '模型配置已变化，请重新选择';
    case 'stale':
      return task.errorSummary ?? '方案已变化，请重新生成';
    default:
      return '已取消';
  }
}

/** C8 核对状态展示：诚实区分"未核对/无法判断/轻微差异/重大偏离"，不用核对通过冒充真实性 */
function checkLine(check: PreviewCheckRecord | null): { label: string; tone: 'muted' | 'ok' | 'warn' } | null {
  if (!check) return null;
  switch (check.overall as PreviewCheckOverall) {
    case 'unchecked':
      return { label: '未自动核对（未配置视觉模型）——请以真实组合与原图为准', tone: 'muted' };
    case 'unknown':
      return { label: '自动核对未完成，无法判断一致性——请以真实组合与原图为准', tone: 'muted' };
    case 'match':
      return { label: '自动核对：关键特征与原图一致（辅助判断，非真实性保证）', tone: 'ok' };
    case 'minor':
      return {
        label: `自动核对：有轻微差异${describeDeviations(check)}（请对照原图确认）`,
        tone: 'warn',
      };
    case 'major':
      return {
        label: `自动核对：重大偏离${describeDeviations(check)}——不建议作为选衣依据，请以真实组合为准`,
        tone: 'warn',
      };
    default:
      return null;
  }
}

function describeDeviations(check: PreviewCheckRecord): string {
  const deviated = check.verdicts.filter((v) => v.status === 'deviate');
  if (deviated.length === 0) return '';
  return `（${deviated.length} 处：${deviated.map((v) => v.note ?? v.itemId).join('；').slice(0, 80)}）`;
}

/** §8.4.8：后处理阶段行——区分"图已生成、核对中/纠偏中""未核对""无法判断""重大偏离" */
function postProcessLine(record: PreviewPostProcessRecord | null): string | null {
  if (!record) return null;
  switch (record.stage) {
    case 'queued':
      return '排队自动核对中…';
    case 'checking':
      return '自动核对中…';
    case 'correcting':
      return '自动核对发现重大偏离，正在按核对意见纠偏重生成（至多一次）…';
    case 'interrupted':
      return `自动核对被中断（${record.error ?? '结果未知'}），未自动重试`;
    default:
      return null; // checked/unchecked/unknown 的结论由核对记录行表达
  }
}

export function PreviewSheet({
  visible,
  onClose,
  basisItemId,
  itemIds,
  wearStyle,
  itemWear,
}: {
  visible: boolean;
  onClose: () => void;
  basisItemId: string;
  itemIds: string[];
  wearStyle: string;
  /** 逐件穿法（C4，itemId → 穿法）：随入队快照与提示词逐件表达 */
  itemWear?: Record<string, string | undefined>;
}) {
  const toast = useToast();
  const [resolution, setResolution] = useState<ConfigResolution | null>(null);
  const [tasks, setTasks] = useState<PreviewTask[]>([]);
  const [checks, setChecks] = useState<Record<string, PreviewCheckRecord | null>>({});
  // §8.4.3：后处理阶段（图已生成、核对中/纠偏中/未核对…）与生成状态分开展示
  const [postProcess, setPostProcess] = useState<Record<string, PreviewPostProcessRecord | null>>({});
  const [currentInput, setCurrentInput] = useState<Awaited<ReturnType<typeof loadCurrentPreviewInput>>>(null);
  // A3：证据缺口提示（可跳过；只提示，不拦截）
  const [evidenceWarnings, setEvidenceWarnings] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);
  // C5：比较模式与选择（最多两张，同条件校验通过才可成组）
  const [compareMode, setCompareMode] = useState(false);
  const [selectedForCompare, setSelectedForCompare] = useState<string[]>([]);
  const [comparisonView, setComparisonView] = useState<{ a: PreviewTask; b: PreviewTask } | null>(null);

  const reload = useCallback(async () => {
    const recent = await listRecentPreviewTasks(8);
    setTasks(recent);
    // C8/§8.4：核对状态与后处理阶段随任务一起加载
    const nextChecks: Record<string, PreviewCheckRecord | null> = {};
    const nextPost: Record<string, PreviewPostProcessRecord | null> = {};
    for (const task of recent) {
      if (task.status === 'succeeded') {
        nextChecks[task.id] = await loadLatestPreviewCheck(task.id);
        nextPost[task.id] = await loadLatestPreviewPostProcess(task.id);
      } else {
        nextChecks[task.id] = null;
        nextPost[task.id] = null;
      }
    }
    setChecks(nextChecks);
    setPostProcess(nextPost);
    // C2/F3："本方案"判定按完整输入版本（单品+版本+逐件穿法+主穿法+参考版本与视角）
    setCurrentInput(await loadCurrentPreviewInput(itemIds, wearStyle, itemWear));
    // A3/§8.8：本次选中单品的证据缺口提示（每件最多一条最关键项，可跳过，不拦截生成）
    const warnings: string[] = [];
    for (const itemId of itemIds.slice(0, 6)) {
      const evidence = await checkGarmentEvidence(itemId);
      if (evidence?.missing.length) warnings.push(`「${evidence.name}」${evidence.missing[0]}`);
    }
    setEvidenceWarnings(warnings);
  }, [itemIds, wearStyle, itemWear]);

  useEffect(() => {
    // R1（2026-11-04）：执行器生命周期由应用层统一管理（app/_layout）；
    // 面板只订阅变化与解析模型候选，不再自行 recover/setForeground。
    void resolveImageGenForPreview().then(setResolution);
    void reload();
    return subscribePreviewChanges(() => void reload());
  }, [visible, reload]);

  function start(configId: string) {
    setStarting(true);
    void (async () => {
      try {
        const result = await enqueuePreview({ basisItemId, itemIds, wearStyle, itemWear, configId });
        if (result.status === 'rejected') {
          Alert.alert(
            '还没有人物参考',
            '生成上身预览需要一张你本人的正面照片作参考（只存本机，仅发送给你配置的图像生成服务）。\n到「我的 → 人物参考」从相册选择一张。',
            [{ text: '知道了' }],
          );
          return;
        }
        toast(result.status === 'created' ? '已开始生成预览' : '本方案已有生成任务在进行');
        void reload();
      } finally {
        setStarting(false);
      }
    })();
  }

  function toggleCompareSelection(taskId: string) {
    setSelectedForCompare((current) =>
      current.includes(taskId)
        ? current.filter((id) => id !== taskId)
        : current.length >= 2
          ? [current[1], taskId]
          : [...current, taskId],
    );
  }

  /** C5：创建比较组（同参考版本校验在仓库层）；允许"都不选"——比较只是并排展示，不强求选择 */
  function startCompare() {
    void (async () => {
      const [aId, bId] = selectedForCompare;
      if (!aId || !bId) {
        toast('先选择两条生成记录');
        return;
      }
      const result = await createPreviewComparison(aId, bId);
      if (!result.ok) {
        toast(result.message);
        return;
      }
      const a = tasks.find((t) => t.id === aId);
      const b = tasks.find((t) => t.id === bId);
      if (!a || !b) {
        toast('生成记录已变化，请重新选择');
        await reload();
        return;
      }
      setComparisonView({ a, b });
      setCompareMode(false);
      setSelectedForCompare([]);
    })();
  }

  function confirmDelete(taskId: string) {
    Alert.alert('删除这条生成记录？', '生成图文件将一并删除，不可恢复。', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            try {
              await deletePreviewTask(taskId);
              toast('已删除');
              await reload();
            } catch (error) {
              toast(`删除失败：${error instanceof Error ? error.message : String(error)}`);
            }
          })();
        },
      },
    ]);
  }

  function onPressGenerate() {
    if (!resolution) return;
    if (resolution.status === 'missing') {
      Alert.alert(
        '还没有图像生成模型',
        '上身预览使用图像生成服务（如 MiniMax image-01）。\n到「我的 → 模型配置」添加配置，能力勾选“图像生成”。',
        [{ text: '知道了' }],
      );
      return;
    }
    if (resolution.status === 'invalid') {
      Alert.alert('模型配置不可用', resolution.message, [{ text: '知道了' }]);
      return;
    }
    if (resolution.status === 'choose') {
      // 多个候选：保持 choose 状态由下方候选列表选择，不静默切换供应商
      return;
    }
    start(resolution.config.id);
  }

  return (
    <Sheet visible={visible} title="上身预览" onClose={onClose}>
      <Notice>AI 生成示意图，非真实试穿。最终效果以你的实际穿着为准。</Notice>
      {evidenceWarnings.length ? (
        <Notice>{`还原依据提示（可跳过，不拦截生成）：${evidenceWarnings.join('；')}`}</Notice>
      ) : null}

      {resolution?.status === 'choose' ? (
        <View>
          <Text style={styles.note}>有多个可用的图像生成模型，选择一个（会记住）：</Text>
          {resolution.candidates.map((config) => (
            <Button
              key={config.id}
              variant="chip"
              label={`${config.name} · ${config.modelId}`}
              onPress={() => {
                void rememberDefaultImageGenConfig(config.id).then(() => {
                  setResolution({ status: 'ready', config, callRevision: callRevisionOf(config) });
                });
              }}
              style={styles.gap}
            />
          ))}
        </View>
      ) : null}

      <Button
        variant="primary"
        label={starting ? '正在提交…' : '生成上身预览'}
        onPress={onPressGenerate}
        disabled={starting}
      />

      <Text style={styles.sectionTitle}>生成记录</Text>
      {tasks.filter((t) => t.status === 'succeeded' && t.resultPreviewPath).length >= 2 ? (
        compareMode ? (
          <View style={styles.compareBar}>
            <Text style={styles.note}>{`已选 ${selectedForCompare.length}/2（同条件校验通过才能比较）`}</Text>
            <View style={styles.compareBarButtons}>
              <Button variant="secondary" label="开始比较" onPress={startCompare} disabled={selectedForCompare.length !== 2} />
              <Button
                variant="text"
                label="取消"
                onPress={() => {
                  setCompareMode(false);
                  setSelectedForCompare([]);
                }}
              />
            </View>
          </View>
        ) : (
          <Button
            variant="text"
            label="比较两套（同条件并排）"
            onPress={() => {
              setCompareMode(true);
              setComparisonView(null);
            }}
          />
        )
      ) : null}

      {comparisonView ? (
        <View style={styles.comparisonCard}>
          <Text style={styles.sectionTitle}>同条件比较</Text>
          <Text style={styles.note}>
            两条记录的人物参考版本、模型配置与提示词模板一致（创建时已校验）；
            姿态/背景等无法硬参数控制的条件仍可能不同，参数一致不保证视觉完全一致。允许两套都不选。
          </Text>
          <View style={styles.compareRow}>
            {[comparisonView.a, comparisonView.b].map((task, index) => {
              const check = checks[task.id] ?? null;
              const line = checkLine(check);
              return (
                <View key={task.id} style={styles.compareCell}>
                  <Text style={styles.note}>{`方案 ${index === 0 ? 'A' : 'B'} · ${task.wearStyle || '自然垂放'}`}</Text>
                  <Image
                    source={{ uri: previewImageUri(task.resultPreviewPath as string) }}
                    style={styles.compareImage}
                    resizeMode="contain"
                    accessibilityLabel={`比较方案 ${index === 0 ? 'A' : 'B'}`}
                  />
                  {line ? (
                    <Text style={[styles.checkText, line.tone === 'warn' ? styles.checkWarn : null]} numberOfLines={3}>
                      {line.label}
                    </Text>
                  ) : null}
                </View>
              );
            })}
          </View>
          <Button variant="text" label="关闭比较" onPress={() => setComparisonView(null)} />
        </View>
      ) : null}

      {tasks.map((task) => {
        const current = currentInput ? previewInputMatches(task, currentInput) : false;
        const checkLineResult = checkLine(checks[task.id] ?? null);
        const postLine = postProcessLine(postProcess[task.id] ?? null);
        const checkOverall = checks[task.id]?.overall ?? null;
        const compareSelectable = task.status === 'succeeded' && !!task.resultPreviewPath && checkOverall !== 'major';
        return (
          <View key={task.id} style={styles.taskCard}>
            <View style={styles.taskHead}>
              <Tag label={current ? '本方案' : '方案已变化'} />
              <Text style={styles.taskStatus}>{statusLine(task)}</Text>
            </View>
            {compareMode && compareSelectable ? (
              <Button
                variant="chip"
                label={selectedForCompare.includes(task.id) ? '已选入比较' : '选入比较'}
                active={selectedForCompare.includes(task.id)}
                onPress={() => toggleCompareSelection(task.id)}
                style={styles.gap}
              />
            ) : null}
            {compareMode && !compareSelectable && task.status === 'succeeded' && task.resultPreviewPath ? (
              <Text style={[styles.checkText, styles.checkWarn]}>自动核对为重大偏离，不进入同条件比较（可单独查看）</Text>
            ) : null}
            {task.status === 'succeeded' && task.resultPreviewPath ? (
              <>
                <Image
                  source={{ uri: previewImageUri(task.resultPreviewPath) }}
                  style={styles.previewImage}
                  resizeMode="contain"
                  accessibilityLabel="上身预览示意图"
                />
                {postLine ? <Text style={styles.checkText}>{postLine}</Text> : null}
                {checkLineResult ? (
                  <Text
                    style={[
                      styles.checkText,
                      checkLineResult.tone === 'warn' ? styles.checkWarn : null,
                      checkLineResult.tone === 'ok' ? styles.checkOk : null,
                    ]}
                  >
                    {checkLineResult.label}
                  </Text>
                ) : null}
              </>
            ) : null}
            {task.status === 'failed' && task.pendingUrl ? (
              // R8：生成成功但保存失败——仅重试下载，不重新生成、不重复计费
              <Button
                variant="secondary"
                label="仅重试下载生成图"
                onPress={() => {
                  void (async () => {
                    try {
                      await retryPreviewSave(task.id);
                      toast('生成图已下载保存');
                      await reload();
                    } catch (error) {
                      toast(`下载失败：${error instanceof Error ? error.message : String(error)}`);
                      await reload();
                    }
                  })();
                }}
                style={styles.gap}
              />
            ) : null}
            {task.status === 'failed' || task.status === 'interrupted' || task.status === 'blocked' ? (
              <Button
                variant="secondary"
                label={resolution?.status === 'ready' ? '重试' : '重试（需先选择模型）'}
                onPress={() => {
                  if (resolution?.status === 'ready') {
                    start(resolution.config.id);
                  } else {
                    void resolveImageGenForPreview().then(setResolution);
                  }
                }}
                style={styles.gap}
              />
            ) : null}
            {isDeletable(task) ? (
              <Button
                variant="text"
                label="删除"
                onPress={() => confirmDelete(task.id)}
                style={styles.gap}
              />
            ) : null}
          </View>
        );
      })}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  note: {
    ...type.footnote,
    color: colors.muted,
    lineHeight: 18,
    marginBottom: 10,
  },
  sectionTitle: {
    ...type.sectionHead,
    color: colors.ink,
    marginTop: 16,
    marginBottom: 8,
  },
  taskCard: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    padding: 10,
    marginBottom: 10,
  },
  taskHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  taskStatus: {
    ...type.footnote,
    color: colors.ink,
    flex: 1,
  },
  previewImage: {
    width: '100%',
    height: 260,
    borderRadius: 8,
    backgroundColor: colors.artBg,
  },
  checkText: {
    ...type.footnote,
    color: colors.muted,
    lineHeight: 18,
    marginTop: 6,
  },
  checkWarn: {
    color: '#B25E09',
  },
  checkOk: {
    color: colors.ink,
  },
  compareBar: {
    marginBottom: 8,
  },
  compareBarButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  comparisonCard: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    padding: 10,
    marginBottom: 10,
  },
  compareRow: {
    flexDirection: 'row',
    gap: 8,
  },
  compareCell: {
    flex: 1,
    minWidth: 0,
  },
  compareImage: {
    width: '100%',
    height: 200,
    borderRadius: 8,
    backgroundColor: colors.artBg,
  },
  gap: {
    marginTop: 8,
  },
});

// AI 推荐面板（M5 轨 B4）：文本模型生成候选组合 → 用户复核（图片+单品）→ 采用进入搭配编辑。
// 诚实边界：候选由 AI 基于档案生成，可能与你的判断不同；数据不足显式显示缺口；
// 采用前复核单品可用性（已删除/归档拦截）；模型未配置或失败保留手动组合入口。

import { useCallback, useEffect, useState } from 'react';
import { Alert, Image, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Sheet } from '../../ui/components/Sheet';
import { Button } from '../../ui/components/Button';
import { Notice, Spinner, Tag } from '../../ui/components/Basics';
import { Field, TextField } from '../../ui/components/Field';
import { useToast } from '../../ui/components/Toast';
import {
  enqueueRecommendation,
  evaluateAdoption,
  getItemAvailability,
  hasActiveRecommendation,
  loadLatestRecommendation,
  loadSceneSnapshot,
  loadWardrobeProfile,
  rememberDefaultRecommendationConfig,
  resolveTextForRecommendation,
  subscribeRecommendationChanges,
  verifySnapshotRevisions,
} from '../recommendationStore';
import { getOutfitSession, loadOutfitFrom, replaceSlot, slotForCategory, type OutfitSlot } from '../outfitSession';
import { checkGarmentEvidence } from '../../services/ai/evidenceCheck';
import { parseRecommendationInputV2 } from '../../services/ai/recommendationInput';
import type { WearStyle } from '@ownfit/contract';
import { getItem } from '../../data/repositories/itemRepository';
import { getMainPhotoPaths, photoUri } from '../../data/repositories/photoRepository';
import type { ConfigResolution } from '../../services/ai/visionConfig';
import type {
  RecommendationCandidate,
  RecommendationTask,
} from '../../data/repositories/recommendationRepository';
import { colors, type } from '../../ui/tokens';

const SLOT_LABELS: Record<string, string> = {
  top: '上衣',
  bottom: '下装',
  dress: '连衣裙',
  shoes: '鞋履',
  outerwear: '外套',
  bag: '包',
  accessory: '配饰',
};

/** 会话槽位名 → 服务层槽位（局部替换显示用） */
const UI_SLOT_TO_ROLE: Record<string, string> = {
  top: 'top',
  dress: 'dress',
  bottom: 'bottom',
  shoes: 'shoes',
  outer: 'outerwear',
};

/** 局部替换候选的替换说明：只换哪件、换成了什么（异步取名称；其余保持不变） */
function ReplaceInfoLine({
  stored,
  candidate,
}: {
  stored: ReturnType<typeof parseRecommendationInputV2> & { mode: 'replace_slot'; targetSlot: string };
  candidate: RecommendationCandidate;
}) {
  const [text, setText] = useState('');
  useEffect(() => {
    let active = true;
    void (async () => {
      const slot = stored.targetSlot;
      const label = SLOT_LABELS[UI_SLOT_TO_ROLE[slot] ?? slot] ?? slot;
      const oldId = stored.baseline?.slots[slot] ?? null;
      const newSlot = candidate.slots.find((s) => UI_SLOT_TO_ROLE[slot] === s.role);
      const [oldItem, newItem] = await Promise.all([
        oldId ? getItem(oldId) : Promise.resolve(null),
        newSlot ? getItem(newSlot.itemId) : Promise.resolve(null),
      ]);
      if (active) {
        setText(
          `本次只换${label}：${oldItem?.name ?? '原件'} → ${newItem?.name ?? '替代件'}（其余单品与穿法保持不变）`,
        );
      }
    })();
    return () => {
      active = false;
    };
  }, [stored, candidate]);
  if (!text) return null;
  return <Text style={styles.reason}>{text}</Text>;
}

/** 本地时区 yyyy-MM-dd HH:mm（finishedAt 是 UTC ISO） */
function formatLocal(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function RecommendationSheet({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [resolution, setResolution] = useState<ConfigResolution | null>(null);
  const [task, setTask] = useState<RecommendationTask | null>(null);
  const [active, setActive] = useState(false);
  const [scene, setScene] = useState<{
    city: string;
    day: string;
    scene: string;
    temp?: string;
    tempSource?: string;
  } | null>(null);
  const [starting, setStarting] = useState(false);
  // B1/D-5：当次要求（选填）——随请求入队快照，只作用于本次
  const [note, setNote] = useState('');
  // A3/D-11：锁定单品的证据缺口（只对锁定项提示，可跳过，不拦截）
  const [lockedWarnings, setLockedWarnings] = useState<string[]>([]);

  const reload = useCallback(async () => {
    setTask(await loadLatestRecommendation());
    setActive(await hasActiveRecommendation());
    setScene(await loadSceneSnapshot());
    const session = getOutfitSession();
    if (session.active && session.locks.length > 0) {
      const warnings: string[] = [];
      for (const itemId of session.locks) {
        const evidence = await checkGarmentEvidence(itemId);
        if (evidence?.missing.length) warnings.push(`「${evidence.name}」${evidence.missing[0]}`);
      }
      setLockedWarnings(warnings);
    } else {
      setLockedWarnings([]);
    }
  }, []);

  useEffect(() => {
    // R1（2026-11-04）：执行器生命周期由应用层统一管理（app/_layout）；
    // 面板只订阅变化与解析模型候选，不再自行 recover/setForeground——
    // 生成期间关闭再打开面板不会把本进程仍在运行的任务误标为 interrupted。
    void resolveTextForRecommendation().then(setResolution);
    void reload();
    return subscribeRecommendationChanges(() => void reload());
  }, [visible, reload]);

  function start(configId: string) {
    if (!scene) return;
    setStarting(true);
    void (async () => {
      try {
        // 当前搭配会话有锁定单品时带入推荐（模型围绕锁定项组合；入队快照持久化）
        const session = getOutfitSession();
        const lockedItemIds = session.active && session.locks.length > 0 ? session.locks : undefined;
        // S1：入队记录组合基线（采用时复核会话是否已变化，不把旧候选覆盖新编辑）
        const baseline = session.active
          ? {
              slots: Object.fromEntries(
                (Object.entries(session.slots) as [string, string][]).filter(([, id]) => !!id),
              ),
              wear: session.wear,
              slotWear: Object.fromEntries(
                (Object.entries(session.slotWear) as [string, string][]).filter(([, style]) => !!style),
              ),
            }
          : undefined;
        const result = await enqueueRecommendation({ scene, configId, lockedItemIds, note, baseline });
        if (result.status === 'rejected') {
          Alert.alert('这次没有发起推荐', result.message, [{ text: '知道了' }]);
          return;
        }
        toast(result.status === 'created' ? 'AI 正在为你搭配…' : '同样的推荐已在进行中');
        await reload();
      } finally {
        setStarting(false);
      }
    })();
  }

  function confirmDelete(taskId: string) {
    Alert.alert('删除这条推荐记录？', '删除后不可恢复；衣橱与已保存的搭配不受影响。', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            try {
              const { deleteRecommendationTask } = await import(
                '../../data/repositories/recommendationRepository'
              );
              await deleteRecommendationTask(taskId);
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
        '还没有文本模型',
        'AI 推荐使用文本模型（如 GLM / DeepSeek，OpenAI 兼容）。\n到「我的 → 模型配置」添加配置，能力勾选“文本”。',
        [{ text: '知道了' }],
      );
      return;
    }
    if (resolution.status === 'invalid') {
      Alert.alert('模型配置不可用', resolution.message, [{ text: '知道了' }]);
      return;
    }
    if (resolution.status === 'choose') return; // 由下方候选列表选择，不静默切换
    start(resolution.config.id);
  }

  /** 采用候选（S1，评估 §8.2.6）：可用性与品类映射复核 → 读取任务快照做采用决策 →
   * 整套采用（保留原请求锁定）或局部替换（会话单次变更，保留其他件/穿法/撤销）。
   * 会话基线/锁定已变化时停止采用并提示重新推荐，不把旧候选覆盖新编辑。 */
  async function adopt(candidate: RecommendationCandidate) {
    const session = getOutfitSession();
    const slots: Partial<Record<'top' | 'dress' | 'bottom' | 'shoes' | 'outer', string>> = {};
    const adoptedIds: string[] = [];
    for (const slot of candidate.slots) {
      if (!(await getItemAvailability(slot.itemId))) {
        Alert.alert('这套搭配含不可用衣物', '部分衣物已删除或归档。请从衣橱重新选择可用衣物搭配。');
        return;
      }
      const item = await getItem(slot.itemId);
      const mapped = item?.category ? slotForCategory(item.category) : null;
      if (!mapped) {
        Alert.alert(
          '候选包含本期不支持的品类',
          `「${item?.name ?? slot.itemId}」是包/配饰类，本期搭配组合暂不支持，请重新生成或手动调整。`,
        );
        return;
      }
      if (slots[mapped]) {
        Alert.alert('候选槽位冲突', '候选把两件衣物放进了同一槽位（按品类判断），已拒绝采用。请换一个候选。');
        return;
      }
      slots[mapped] = slot.itemId;
      adoptedIds.push(slot.itemId);
    }
    // 连衣裙与上衣/下装互斥：品类映射后复核一次，不静默丢弃
    if (slots.dress && (slots.top || slots.bottom)) {
      Alert.alert('候选组合冲突', '连衣裙与上衣/下装不能同时出现，已拒绝采用。请换一个候选。');
      return;
    }
    // 候选单品的资料版本仍与请求一致（等待期间被改过 → 提示重新推荐）
    const stored = parseRecommendationInputV2(task?.inputJson ?? null);
    if (stored) {
      const revisions = await verifySnapshotRevisions(stored, adoptedIds);
      if (!revisions.ok) {
        Alert.alert('结果已过期', revisions.message, [{ text: '知道了' }]);
        return;
      }
    }
    const decision = evaluateAdoption({
      stored,
      candidate,
      mappedSlots: slots,
      session: session.active
        ? {
            active: true,
            slots: session.slots,
            locks: session.locks,
            wear: session.wear,
            slotWear: session.slotWear,
          }
        : null,
    });
    if (decision.action === 'blocked') {
      Alert.alert('无法直接采用', decision.message, [{ text: '知道了' }]);
      return;
    }
    if (decision.action === 'replace_slot') {
      const applied = replaceSlot(decision.slot as OutfitSlot, decision.itemId);
      if (applied === 'locked') {
        Alert.alert('目标单品已锁定', '先解锁这一件，再采用替换建议。', [{ text: '知道了' }]);
        return;
      }
      toast('已按推荐替换这一件（其他单品与穿法保持不变）');
      onClose();
      return;
    }
    loadOutfitFrom({
      planId: '',
      name: null,
      basisId: decision.basisId,
      slots: decision.slots as Partial<Record<'top' | 'dress' | 'bottom' | 'shoes' | 'outer', string>>,
      wear: decision.wear as WearStyle,
      itemIds: decision.itemIds,
      // 保存时保留 AI 来源与理由（M6 批次 1.2：不再固定 manual/null）
      origin: { source: 'ai', reason: decision.reason },
      // R3/S1：整套采用保留原请求锁定（来自快照，不是此刻 session）
      locks: decision.locks,
    });
    onClose();
    router.push('/outfit');
  }

  function renderTaskBlock(t: RecommendationTask): React.ReactNode {
    if (t.status === 'running' || t.status === 'queued') {
      return (
        <View style={styles.card}>
          <Text style={styles.note}>{t.status === 'queued' ? '排队中…' : 'AI 搭配中…（约 30-60 秒）'}</Text>
          <Spinner />
        </View>
      );
    }
    if (t.status === 'failed' || t.status === 'interrupted' || t.status === 'blocked') {
      return (
        <View style={styles.card}>
          <Text style={styles.note}>
            {t.status === 'blocked'
              ? t.errorSummary ?? '模型配置已变化，请重新生成'
              : `${t.status === 'interrupted' ? '结果未知' : '生成失败'}：${t.errorSummary ?? '未知原因'}`}
          </Text>
          <Button
            variant="secondary"
            label={resolution?.status === 'ready' ? '重试' : '重试（需先选择模型）'}
            onPress={() => {
              if (resolution?.status === 'ready') {
                start(resolution.config.id);
              } else {
                void resolveTextForRecommendation().then(setResolution);
              }
            }}
          />
        </View>
      );
    }
    if (t.status !== 'succeeded' || !t.candidates) return null;
    const stored = parseRecommendationInputV2(t.inputJson);
    const replaceSlot = stored?.mode === 'replace_slot' ? stored.targetSlot : null;
    return (
      <View>
        {t.candidates.map((candidate, index) => (
          <View key={`${index}-${candidate.wearStyle}`} style={styles.card}>
            <View style={styles.candidateHead}>
              <Tag label={replaceSlot ? `只换${SLOT_LABELS[UI_SLOT_TO_ROLE[replaceSlot] ?? ''] ?? ''}` : `候选 ${index + 1}`} />
              <Text style={styles.wearStyleText}>{candidate.wearStyle}</Text>
            </View>
            {replaceSlot && stored ? (
              <ReplaceInfoLine
                stored={stored as typeof stored & { mode: 'replace_slot'; targetSlot: string }}
                candidate={candidate}
              />
            ) : null}
            <View style={styles.slotRow}>
              {candidate.slots.map((slot) => (
                <ItemThumb
                  key={`${slot.role}-${slot.itemId}`}
                  itemId={slot.itemId}
                  label={SLOT_LABELS[slot.role] ?? slot.role}
                />
              ))}
            </View>
            {candidate.reason ? <Text style={styles.reason}>{candidate.reason}</Text> : null}
            <Button
              variant="primary"
              label="用这套搭配"
              onPress={() => void adopt(candidate)}
              style={styles.gap}
            />
          </View>
        ))}
      </View>
    );
  }

  return (
    <Sheet visible={visible} title="AI 帮你搭一套" onClose={onClose}>
      <Notice>候选由 AI 基于你的衣物档案与当次场景生成，可能与你的判断不同。采用前请复核图片与单品。</Notice>

      {resolution?.status === 'choose' ? (
        <View>
          <Text style={styles.note}>有多个可用的文本模型，选择一个（会记住）：</Text>
          {resolution.candidates.map((config) => (
            <Button
              key={config.id}
              variant="chip"
              label={`${config.name} · ${config.modelId}`}
              onPress={() => {
                void rememberDefaultRecommendationConfig(config.id).then(() => {
                  setResolution({ status: 'ready', config, callRevision: callRevisionLabel(config) });
                });
              }}
              style={styles.gap}
            />
          ))}
        </View>
      ) : null}

      <Button
        variant="primary"
        label={starting || active ? 'AI 搭配中…' : '生成候选组合'}
        onPress={onPressGenerate}
        disabled={starting || active || resolution?.status === 'choose'}
      />
      {active ? <Spinner /> : null}

      {/* B1：请求摘要——本次发送给 AI 的约束可见可改；全部可跳过，不增加每日问卷 */}
      {scene ? (
        <View style={styles.requestBox}>
          <Text style={styles.note}>
            {`场景：${scene.city} · ${scene.day} · ${scene.scene}${scene.temp ? ` · ${scene.temp}` : ' · 未查天气'}`}
          </Text>
          <Text style={styles.note}>
            {getOutfitSession().active && getOutfitSession().locks.length > 0
              ? `锁定：${getOutfitSession().locks.length} 件（候选必须包含）`
              : '锁定：无（可到搭配页锁定单品）'}
          </Text>
          {lockedWarnings.map((warning) => (
            <Text key={warning} style={styles.warningNote}>
              {warning}
            </Text>
          ))}
          <Text style={styles.note}>
            长期偏好会参与排序；下面的“本次要求”只对这次有效，可留空。
          </Text>
          <Field label="本次要求（选填，如：只换鞋 / 更正式一点 / 步行 20 分钟）">
            <TextField
              value={note}
              onChangeText={setNote}
              placeholder="留空则按场景与偏好搭配"
              maxLength={120}
            />
          </Field>
        </View>
      ) : null}

      <Text style={styles.sectionTitle}>最近推荐</Text>
      {!task ? (
        <Text style={styles.note}>
          还没有推荐记录。生成后，候选会显示在这里，可复核后直接进入搭配编辑。
        </Text>
      ) : null}
      {task && (task.status === 'running' || task.status === 'queued') ? (
        <View style={styles.card}>
          <Text style={styles.note}>{task.status === 'queued' ? '排队中…' : 'AI 搭配中…（约 30-60 秒）'}</Text>
          <Spinner />
        </View>
      ) : null}
      {task &&
      (task.status === 'failed' || task.status === 'interrupted' || task.status === 'blocked') ? (
        <View style={styles.card}>
          <Text style={styles.note}>
            {task.status === 'blocked'
              ? task.errorSummary ?? '模型配置已变化，请重新生成'
              : `${task.status === 'interrupted' ? '结果未知' : '生成失败'}：${task.errorSummary ?? '未知原因'}`}
          </Text>
          <Button
            variant="secondary"
            label={resolution?.status === 'ready' ? '重试' : '重试（需先选择模型）'}
            onPress={() => {
              if (resolution?.status === 'ready') {
                start(resolution.config.id);
              } else {
                void resolveTextForRecommendation().then(setResolution);
              }
            }}
          />
        </View>
      ) : null}
      {(() => {
        const stored = task ? parseRecommendationInputV2(task.inputJson) : null;
        const replaceSlot = stored?.mode === 'replace_slot' ? stored.targetSlot : null;
        return task?.candidates?.map((candidate, index) => (
          <View key={`${index}-${candidate.wearStyle}`} style={styles.card}>
            <View style={styles.candidateHead}>
              <Tag label={replaceSlot ? `只换${SLOT_LABELS[UI_SLOT_TO_ROLE[replaceSlot] ?? ''] ?? ''}` : `候选 ${index + 1}`} />
              <Text style={styles.wearStyleText}>{candidate.wearStyle}</Text>
            </View>
            {replaceSlot && stored ? (
              <ReplaceInfoLine
                stored={stored as typeof stored & { mode: 'replace_slot'; targetSlot: string }}
                candidate={candidate}
              />
            ) : null}
            <View style={styles.slotRow}>
              {candidate.slots.map((slot) => (
                <ItemThumb
                  key={`${slot.role}-${slot.itemId}`}
                  itemId={slot.itemId}
                  label={SLOT_LABELS[slot.role] ?? slot.role}
                />
              ))}
            </View>
            {candidate.reason ? <Text style={styles.reason}>{candidate.reason}</Text> : null}
            <Button
              variant="primary"
              label="用这套搭配"
              onPress={() => void adopt(candidate)}
              style={styles.gap}
            />
          </View>
        ));
      })()}
      {task && task.gaps.length > 0 ? <Notice>{`档案缺口：${task.gaps.join('；')}`}</Notice> : null}
      {task?.summary ? <Text style={styles.reason}>{task.summary}</Text> : null}
      {task &&
      (task.status === 'succeeded' ||
        task.status === 'failed' ||
        task.status === 'interrupted' ||
        task.status === 'blocked') ? (
        <Button
          variant="text"
          label="删除这条推荐记录"
          onPress={() => confirmDelete(task.id)}
        />
      ) : null}
    </Sheet>
  );
}

function callRevisionLabel(config: { callRevision?: string }): string {
  return config.callRevision ?? '';
}

/** 候选复核缩略图：单品主图（已删除/缺图显示占位） */
function ItemThumb({ itemId, label }: { itemId: string; label: string }) {
  const [uri, setUri] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    void (async () => {
      const item = await getItem(itemId);
      if (!item || item.status !== 'active' || !item.mainPhotoId) {
        setMissing(true);
        return;
      }
      const paths = await getMainPhotoPaths(itemId);
      if (paths) setUri(photoUri(paths.thumbPath));
      else setMissing(true);
    })();
  }, [itemId]);
  return (
    <View style={styles.thumbWrap}>
      {uri && !missing ? (
        <Image source={{ uri }} style={styles.thumbImage} resizeMode="cover" />
      ) : (
        <View style={[styles.thumbImage, styles.thumbPlaceholder]}>
          <Text style={styles.thumbPlaceholderText}>不可用</Text>
        </View>
      )}
      <Text style={styles.thumbLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  note: {
    ...type.footnote,
    color: colors.muted,
    lineHeight: 18,
    marginTop: 4,
  },
  warningNote: {
    ...type.micro,
    color: '#B25E09',
    lineHeight: 16,
    marginTop: 2,
  },
  sectionTitle: {
    ...type.sectionHead,
    color: colors.ink,
    marginTop: 16,
    marginBottom: 8,
  },
  card: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    padding: 10,
    marginBottom: 10,
  },
  requestBox: {
    marginTop: 8,
    padding: 10,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
  },
  candidateHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  wearStyleText: {
    ...type.footnote,
    color: colors.ink,
  },
  slotRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 6,
  },
  thumbWrap: {
    alignItems: 'center',
  },
  thumbImage: {
    width: 72,
    height: 96,
    borderRadius: 8,
    backgroundColor: colors.artBg,
  },
  thumbPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbPlaceholderText: {
    ...type.micro,
    color: colors.muted,
  },
  thumbLabel: {
    ...type.micro,
    color: colors.muted,
    marginTop: 2,
  },
  reason: {
    ...type.footnote,
    color: colors.muted,
    lineHeight: 18,
    marginBottom: 6,
  },
  gap: {
    marginTop: 4,
  },
});

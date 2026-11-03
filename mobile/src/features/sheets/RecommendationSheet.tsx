// AI 推荐面板（M5 轨 B4）：文本模型生成候选组合 → 用户复核（图片+单品）→ 采用进入搭配编辑。
// 诚实边界：候选由 AI 基于档案生成，可能与你的判断不同；数据不足显式显示缺口；
// 采用前复核单品可用性（已删除/归档拦截）；模型未配置或失败保留手动组合入口。

import { useCallback, useEffect, useState } from 'react';
import { Alert, Image, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Sheet } from '../../ui/components/Sheet';
import { Button } from '../../ui/components/Button';
import { Notice, Spinner, Tag } from '../../ui/components/Basics';
import { useToast } from '../../ui/components/Toast';
import {
  enqueueRecommendation,
  getItemAvailability,
  hasActiveRecommendation,
  initRecommendationRunner,
  loadLatestRecommendation,
  loadSceneSnapshot,
  loadWardrobeProfile,
  rememberDefaultRecommendationConfig,
  resolveTextForRecommendation,
  subscribeRecommendationChanges,
} from '../recommendationStore';
import { loadOutfitFrom, slotForCategory } from '../outfitSession';
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
  const [scene, setScene] = useState<{ city: string; day: string; scene: string } | null>(null);
  const [starting, setStarting] = useState(false);

  const reload = useCallback(async () => {
    setTask(await loadLatestRecommendation());
    setActive(await hasActiveRecommendation());
    setScene(await loadSceneSnapshot());
  }, []);

  useEffect(() => {
    if (!visible) {
      initRecommendationRunner().setForeground(false);
      return;
    }
    const runner = initRecommendationRunner();
    runner.start();
    void runner
      .recover()
      .catch(() => undefined)
      .then(() => runner.setForeground(true));
    void resolveTextForRecommendation().then(setResolution);
    void reload();
    return subscribeRecommendationChanges(() => void reload());
  }, [visible, reload]);

  function start(configId: string) {
    if (!scene) return;
    setStarting(true);
    void (async () => {
      try {
        const result = await enqueueRecommendation({ scene, configId });
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

  /** 采用候选：复核单品可用性 → 槽位按品类映射 → 进入搭配编辑 */
  async function adopt(candidate: RecommendationCandidate) {
    const slots: Partial<Record<'top' | 'dress' | 'bottom' | 'shoes', string>> = {};
    for (const slot of candidate.slots) {
      if (!(await getItemAvailability(slot.itemId))) {
        Alert.alert('这套搭配含不可用衣物', '部分衣物已删除或归档。请从衣橱重新选择可用衣物搭配。');
        return;
      }
      const item = await getItem(slot.itemId);
      const mapped = item?.category ? slotForCategory(item.category) : null;
      const role = (mapped ?? slot.role) as 'top' | 'dress' | 'bottom' | 'shoes';
      if (!slots[role]) slots[role] = slot.itemId;
    }
    loadOutfitFrom({
      planId: '',
      name: null,
      basisId: candidate.slots[0]?.itemId ?? '',
      slots,
      wear: candidate.wearStyle as WearStyle,
      itemIds: candidate.slots.map((slot) => slot.itemId),
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
    return (
      <View>
        {t.candidates.map((candidate, index) => (
          <View key={`${index}-${candidate.wearStyle}`} style={styles.card}>
            <View style={styles.candidateHead}>
              <Tag label={`候选 ${index + 1}`} />
              <Text style={styles.wearStyleText}>{candidate.wearStyle}</Text>
            </View>
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
      {scene ? <Text style={styles.note}>{`场景：${scene.city} · ${scene.day} · ${scene.scene}`}</Text> : null}

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
      {task?.candidates?.map((candidate, index) => (
        <View key={`${index}-${candidate.wearStyle}`} style={styles.card}>
          <View style={styles.candidateHead}>
            <Tag label={`候选 ${index + 1}`} />
            <Text style={styles.wearStyleText}>{candidate.wearStyle}</Text>
          </View>
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

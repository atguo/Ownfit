import { useCallback, useEffect, useState } from 'react';
import { Alert, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { Page } from '../../ui/Screen';
import { PageTop } from '../../ui/PageTop';
import { Button } from '../../ui/components/Button';
import { EmptyState } from '../../ui/components/Basics';
import { useToast } from '../../ui/components/Toast';
import { WardrobeItemSheet, type WardrobeItemDetail } from '../../features/sheets/WardrobeItemSheet';
import { VisionModelSheet } from '../../features/sheets/VisionModelSheet';
import {
  getItem,
  getMainThumb,
  listItemIdsByStatus,
  type ItemStatus,
  type WardrobeItem,
} from '../../data/repositories/itemRepository';
import { getMainPhotoPaths, photoUri } from '../../data/repositories/photoRepository';
import { getAnalysisView } from '../../data/repositories/attributeRepository';
import type { AnalysisTaskStatus } from '../../data/repositories/analysisTypes';
import type { ModelConfig } from '../../services/ai/types';
import {
  createActionId,
  initGarmentTaskRunner,
  notifyAnalysisDbChanged,
  rememberDefaultVisionConfig,
  requestKeyFor,
  resolveVisionForAnalysis,
  subscribeAnalysisChanges,
} from '../../features/garmentAnalysisStore';
import { categories, type ItemCategory } from '../../data/demo';
import { startOutfitFrom } from '../../features/outfitSession';
import { colors, type } from '../../ui/tokens';

const filters: ('全部' | ItemCategory)[] = ['全部', ...categories];

interface ItemView {
  item: WardrobeItem;
  thumbUri: string | null;
  originalUri: string | null;
  /** 最新一次分析任务状态（null = 从未分析过） */
  analysisStatus: AnalysisTaskStatus | null;
  hasResult: boolean;
}

function analysisSuffix(view: ItemView): string {
  if (view.analysisStatus === null) return ' · 未分析';
  if (view.analysisStatus === 'queued' || view.analysisStatus === 'running') return ' · 分析中';
  if (view.hasResult) return ' · 已有分析建议';
  if (view.analysisStatus === 'succeeded') return ' · 照片不够清楚';
  return ' · 分析未完成';
}

// 衣橱（M2 真实版）：SQLite 数据源 + 筛选 + 草稿区 + 已归档入口。
// 演示数据不出现在此页（AGENTS §4 规则 5：真实衣橱与演示隔离）。
export default function WardrobeScreen() {
  const router = useRouter();
  const toast = useToast();
  const [drafts, setDrafts] = useState<ItemView[]>([]);
  const [active, setActive] = useState<ItemView[]>([]);
  const [archived, setArchived] = useState<ItemView[]>([]);
  const [filter, setFilter] = useState<'全部' | ItemCategory | '已归档'>('全部');
  const [detail, setDetail] = useState<WardrobeItemDetail | null>(null);
  const [modelCandidates, setModelCandidates] = useState<ModelConfig[] | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const loadViews = async (status: ItemStatus): Promise<ItemView[]> => {
      const ids = await listItemIdsByStatus(status);
      const views: ItemView[] = [];
      for (const id of ids) {
        const [item, paths, analysis] = await Promise.all([
          getItem(id),
          getMainPhotoPaths(id),
          getAnalysisView(id),
        ]);
        if (item) {
          views.push({
            item,
            thumbUri: paths ? photoUri(paths.thumbPath) : null,
            originalUri: paths ? photoUri(paths.originalPath) : null,
            analysisStatus: analysis.latestTask?.status ?? null,
            hasResult: analysis.lastValidResult !== null,
          });
        }
      }
      return views;
    };
    setDrafts(await loadViews('draft'));
    setActive(await loadViews('active'));
    setArchived(await loadViews('archived'));
    setLoaded(true);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // 分析任务状态变化（排队/完成/失败）后刷新列表与计数
  useEffect(() => subscribeAnalysisChanges(() => void load()), [load]);

  /** 批量补分析：只处理 draft/active、有主图、从未创建过任务的衣物 */
  const unanalyzed = [...drafts, ...active].filter(
    (view) => view.analysisStatus === null && view.item.mainPhotoId != null,
  );

  async function analyseUnanalyzed() {
    if (unanalyzed.length === 0) {
      toast('没有等待分析的衣物');
      return;
    }
    const runner = initGarmentTaskRunner();
    const resolution = await resolveVisionForAnalysis();
    if (resolution.status === 'choose') {
      setModelCandidates(resolution.candidates);
      return;
    }
    if (resolution.status !== 'ready') {
      Alert.alert(
        '暂不能分析',
        resolution.status === 'missing'
          ? '还没有可用于图片理解的模型配置。到“模型配置”添加一条带“视觉理解”能力的配置后再试。'
          : resolution.message,
        [{ text: '知道了', style: 'cancel' }],
      );
      return;
    }
    const actionId = createActionId();
    let started = 0;
    for (const view of unanalyzed) {
      const result = await runner.enqueueGarmentAnalysis({
        itemId: view.item.id,
        configId: resolution.config.id,
        trigger: 'batch',
        requestKey: requestKeyFor(actionId, view.item.id),
      });
      if (result.status !== 'rejected') started += 1;
    }
    notifyAnalysisDbChanged();
    toast(started > 0 ? `已排队分析 ${started} 件` : '这些衣物暂时无法排队分析');
  }

  async function selectBatchModel(configId: string) {
    setModelCandidates(null);
    await rememberDefaultVisionConfig(configId);
    await analyseUnanalyzed();
  }

  const showArchived = filter === '已归档';
  const list = showArchived
    ? archived
    : active.filter((v) => filter === '全部' || v.item.category === filter);
  const hasArchived = archived.length > 0;

  function renderCard(view: ItemView) {
    const isDraft = view.item.status === 'draft';
    const base = isDraft
      ? '草稿 · 待确认品类'
      : `${view.item.category ?? '未分类'} / ${view.item.status === 'archived' ? '已归档' : '已入库'}`;
    const meta = view.item.status === 'archived' ? base : `${base}${analysisSuffix(view)}`;
    return (
      <Pressable
        key={view.item.id}
        accessibilityRole="button"
        accessibilityLabel={view.item.name ?? view.item.category ?? '单品'}
        onPress={() => setDetail(view)}
        style={styles.card}>
        {view.thumbUri ? (
          <Image source={{ uri: view.thumbUri }} style={styles.cardArt} resizeMode="cover" />
        ) : (
          <View style={[styles.cardArt, styles.cardArtPlaceholder]} />
        )}
        <Text style={styles.cardName} numberOfLines={1}>
          {view.item.name ?? view.item.category ?? '未分类草稿'}
        </Text>
        <Text style={styles.cardMeta}>{meta}</Text>
      </Pressable>
    );
  }

  return (
    <Page>
      <PageTop
        title="我的衣橱"
        sub={`${active.length} 件已录入 · 慢慢收集，常常喜欢`}
        right={
          <Button
            variant="round"
            icon="plus"
            accessibilityLabel="添加衣服"
            onPress={() => router.push('/add')}
          />
        }
      />

      <View style={styles.chips}>
        {filters.map((c) => (
          <Button key={c} variant="chip" label={c} active={filter === c} onPress={() => setFilter(c)} />
        ))}
        {hasArchived ? (
          <Button
            variant="chip"
            label={`已归档 ${archived.length}`}
            active={showArchived}
            onPress={() => setFilter('已归档')}
          />
        ) : null}
      </View>

      {unanalyzed.length > 0 && !showArchived ? (
        <Button
          variant="secondary"
          label={`分析未分析衣物（${unanalyzed.length} 件）`}
          onPress={() => void analyseUnanalyzed()}
          style={styles.analyseAll}
        />
      ) : null}

      {drafts.length > 0 && !showArchived ? (
        <>
          <Text style={styles.draftHead}>草稿 · 待确认品类（{drafts.length}）</Text>
          <View style={styles.grid}>{drafts.map(renderCard)}</View>
        </>
      ) : null}

      {list.length > 0 ? (
        <View style={styles.mainSection}>
          <View style={styles.grid}>{list.map(renderCard)}</View>
          {!showArchived ? (
            <Text style={styles.subtleInfo}>照片先存下来，尺寸和细节用到时再补。</Text>
          ) : null}
        </View>
      ) : drafts.length === 0 ? (
        <EmptyState
          icon="closet"
          title={showArchived ? '没有已归档的单品' : '一件，就是好的开始。'}
          action={
            showArchived ? undefined : { label: '添加第一件', onPress: () => router.push('/add') }
          }>
          {showArchived
            ? '归档的单品会出现在这里。'
            : '先添加今天想穿的衣服，\n不需要一次整理整个衣橱。'}
        </EmptyState>
      ) : null}

      <VisionModelSheet
        visible={modelCandidates !== null}
        candidates={modelCandidates ?? []}
        onSelect={(configId) => void selectBatchModel(configId)}
        onClose={() => setModelCandidates(null)}
      />

      <WardrobeItemSheet
        detail={detail}
        onClose={() => setDetail(null)}
        onChanged={() => {
          // 只刷新列表（卡片状态/名称/已删除标记）；需要关弹层的操作自己调 onClose
          void load();
        }}
        onUse={(id) => {
          void startOutfitFrom(id).then((ok) => {
            if (ok) router.push('/outfit');
          });
        }}
      />
    </Page>
  );
}

const styles = StyleSheet.create({
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginVertical: 17,
  },
  draftHead: {
    ...type.heading,
    color: colors.ink,
    marginTop: 6,
    marginBottom: 12,
  },
  analyseAll: {
    alignSelf: 'stretch',
    marginBottom: 6,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 19,
    columnGap: 13,
  },
  mainSection: {
    marginTop: 17,
  },
  card: {
    width: '47.5%',
    alignItems: 'flex-start',
  },
  cardArt: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: 15,
    backgroundColor: colors.artBg,
  },
  cardArtPlaceholder: {
    backgroundColor: colors.line,
  },
  cardName: {
    color: colors.ink,
    fontSize: 12,
    fontWeight: '500',
    lineHeight: 18,
    marginTop: 9,
  },
  cardMeta: {
    color: colors.muted,
    fontSize: 10,
    lineHeight: 14,
    marginTop: 3,
  },
  subtleInfo: {
    ...type.footnote,
    lineHeight: 20,
    color: colors.subtleInfo,
    marginTop: 15,
    marginBottom: 12,
  },
});


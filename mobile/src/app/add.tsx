import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Image, StyleSheet, Text, View } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { Page } from '../ui/Screen';
import { BackTitle } from '../ui/PageTop';
import { Button } from '../ui/components/Button';
import { Notice } from '../ui/components/Basics';
import { TextField } from '../ui/components/Field';
import { useToast } from '../ui/components/Toast';
import { photoUri } from '../data/repositories/photoRepository';
import {
  confirmItem,
  createDraftFromPhoto,
  getItem,
  getMainThumb,
  listItemIdsByStatus,
  type WardrobeItem,
} from '../data/repositories/itemRepository';
import { getAnalysisView } from '../data/repositories/attributeRepository';
import type { AnalysisTaskStatus } from '../data/repositories/analysisTypes';
import type { ModelConfig } from '../services/ai/types';
import { VisionModelSheet } from '../features/sheets/VisionModelSheet';
import {
  clearSessionBatch,
  getSessionBatch,
  initGarmentTaskRunner,
  notifyAnalysisChanged,
  rememberDefaultVisionConfig,
  removeFromSessionBatch,
  requestKeyFor,
  resolveVisionForAnalysis,
  setSessionBatch,
  subscribeAnalysisChanges,
  createActionId,
} from '../features/garmentAnalysisStore';
import { categories, type ItemCategory } from '../data/demo';
import { colors, radius, type } from '../ui/tokens';

// 添加一件衣服：拍照/相册多选 → 每张自动建草稿 → 分析建议 → 逐件确认品类入库。
// 规则：取消选图不建任何草稿；草稿持久化（重启可恢复）；品类确认前不入库；
// 照片保存成功后自动排队做衣物分析（不阻塞保存）；用户输入与 AI 建议分开保存。

interface DraftView extends WardrobeItem {
  thumbUri: string | null;
}

interface DraftSuggestion {
  /** 分析完成后可用的建议（仅来自当前照片的最新成功结果） */
  name?: string;
  category?: ItemCategory;
  hasResult: boolean;
  status: AnalysisTaskStatus | null;
}

export default function AddScreen() {
  const router = useRouter();
  const toast = useToast();
  const [drafts, setDrafts] = useState<DraftView[]>([]);
  /** 用户输入的名称（只有用户改过才有键；空字符串表示用户主动清空） */
  const [names, setNames] = useState<Record<string, string>>({});
  /** 用户选择的品类（只有用户点过才有键） */
  const [pickedCategories, setPickedCategories] = useState<Record<string, ItemCategory>>({});
  const [suggestions, setSuggestions] = useState<Record<string, DraftSuggestion>>({});
  const [modelCandidates, setModelCandidates] = useState<ModelConfig[] | null>(null);
  const [busy, setBusy] = useState(false);

  const draftIdsRef = useRef<string[]>([]);
  /** 等待用户选择/配置模型的批次：返回录入页时据此续接 */
  const pendingConfigRef = useRef<{ actionId: string; itemIds: string[] } | null>(null);
  const resumedActionRef = useRef<string | null>(null);

  const refreshSuggestions = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;
    const next: Record<string, DraftSuggestion> = {};
    for (const id of ids) {
      // 视图已按“人工优先、取当前照片最新成功结果”的规则组装，页面不自行拼接多次输出
      const view = await getAnalysisView(id);
      const entry: DraftSuggestion = {
        hasResult: view.lastValidResult !== null,
        status: view.latestTask?.status ?? null,
      };
      // 名称/品类建议来自最新有效结果（内置字段）；用户未编辑时才预填
      if (view.suggestedName?.value) entry.name = view.suggestedName.value;
      if (view.category?.value) entry.category = view.category.value as ItemCategory;
      next[id] = entry;
    }
    setSuggestions((prev) => ({ ...prev, ...next }));
  }, []);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      (async () => {
        const ids = await listItemIdsByStatus('draft');
        const views: DraftView[] = [];
        for (const id of ids) {
          // 读真实草稿记录（含 revision 等字段），不要用假值拼装 WardrobeItem
          const [item, thumbUri] = await Promise.all([getItem(id), getMainThumb(id)]);
          if (!item) continue;
          views.push({ ...item, thumbUri: thumbUri ? photoUri(thumbUri) : null });
        }
        if (!active) return;
        setDrafts(views);
        draftIdsRef.current = views.map((view) => view.id);
        void refreshSuggestions(draftIdsRef.current);

        // 从配置页返回时续接本批尚未发送的分析；同一批不每次聚焦都重试
        const batch = getSessionBatch();
        if (
          batch &&
          batch.itemIds.length > 0 &&
          (resumedActionRef.current !== batch.actionId || pendingConfigRef.current !== null)
        ) {
          resumedActionRef.current = batch.actionId;
          void startBatchAnalysis(batch.actionId, batch.itemIds);
        }
      })();
      return () => {
        active = false;
      };
    }, [refreshSuggestions]),
  );

  // 任务状态/属性变化后刷新建议；只更新建议与列表，不改动用户已输入的名称与品类
  useEffect(() => {
    const unsubscribe = subscribeAnalysisChanges(() => {
      void refreshSuggestions(draftIdsRef.current);
    });
    return unsubscribe;
  }, [refreshSuggestions]);

  // 会话结束（页面卸载）时清掉批次，避免以后偷偷处理历史草稿
  useEffect(() => () => clearSessionBatch(), []);

  /**
   * 为一批新草稿排队分析。
   * - 模型未配置/失效：只提示一次，提供“去配置/暂不分析”，照片与草稿照常保留；
   * - 多个候选：打开选择弹层，选定后记住并继续本批；
   * - 就绪：逐件入队（同一批共用一个 actionId，逐件幂等键）。
   */
  async function startBatchAnalysis(actionId: string, itemIds: string[]) {
    if (itemIds.length === 0) return;
    const runner = initGarmentTaskRunner();
    const resolution = await resolveVisionForAnalysis();

    if (resolution.status === 'choose') {
      pendingConfigRef.current = { actionId, itemIds };
      setModelCandidates(resolution.candidates);
      return;
    }
    if (resolution.status !== 'ready') {
      pendingConfigRef.current = { actionId, itemIds };
      const message =
        resolution.status === 'missing'
          ? '还没有可用于图片理解的模型配置。到“模型配置”添加一条带“视觉理解”能力的配置后，回来即可继续分析本批照片。'
          : resolution.message;
      Alert.alert('本次暂不分析照片', `${message}\n\n照片与草稿已经保存在本机，不会丢。`, [
        { text: '暂不分析', style: 'cancel' },
        { text: '去配置', onPress: () => router.push('/ai/config') },
      ]);
      return;
    }

    pendingConfigRef.current = null;
    setModelCandidates(null);
    const configId = resolution.config.id;
    let rejected = 0;
    for (const itemId of itemIds) {
      const result = await runner.enqueueGarmentAnalysis({
        itemId,
        configId,
        trigger: 'auto',
        requestKey: requestKeyFor(actionId, itemId),
      });
      if (result.status === 'rejected') rejected += 1;
      else removeFromSessionBatch(itemId);
    }
    if (getSessionBatch()?.itemIds.length === 0) clearSessionBatch();
    if (rejected > 0) toast(`有 ${rejected} 件暂且无法分析，稍后可在衣橱里重试`);
    notifyAnalysisChanged();
  }

  // 选图 → 逐张建草稿 → 保存成功后为本批排队分析（保存不等待 AI）
  async function pickAndCreate(picker: () => Promise<ImagePicker.ImagePickerResult>) {
    if (busy) return;
    setBusy(true);
    try {
      const result = await picker();
      if (result.canceled || !result.assets?.length) return; // 取消：不建草稿

      const createdIds: string[] = [];
      let created = 0;
      for (const asset of result.assets) {
        const clientRef = `pick-${asset.assetId ?? asset.uri}-${Date.now().toString(36)}`;
        try {
          const item = await createDraftFromPhoto(asset.uri, clientRef, asset.width, asset.height);
          const thumbUri = await getMainThumb(item.id);
          const view: DraftView = { ...item, thumbUri: thumbUri ? photoUri(thumbUri) : null };
          setDrafts((prev) => [...prev, view]);
          draftIdsRef.current = [...draftIdsRef.current, item.id];
          createdIds.push(item.id);
          created += 1;
        } catch (error) {
          toast(`第 ${created + 1} 张保存失败：${error instanceof Error ? error.message : String(error)}`);
          break;
        }
      }
      if (created > 0) {
        toast(created > 1 ? `已存入 ${created} 份草稿，正在分析` : '已存入草稿，正在分析');
      }
      if (createdIds.length > 0) {
        const actionId = createActionId();
        setSessionBatch({ actionId, itemIds: createdIds });
        resumedActionRef.current = actionId;
        await startBatchAnalysis(actionId, createdIds);
      }
    } finally {
      setBusy(false);
    }
  }

  async function takePhoto() {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      // 拒绝权限可走替代路径
      toast('相机权限被拒绝，可改用“从相册选择”入库');
      return;
    }
    await pickAndCreate(() => ImagePicker.launchCameraAsync({ quality: 1, exif: false }));
  }

  async function pickFromLibrary() {
    await pickAndCreate(() =>
      ImagePicker.launchImageLibraryAsync({
        allowsMultipleSelection: true,
        selectionLimit: 10,
        quality: 1,
        exif: false,
      }),
    );
  }

  async function selectModel(configId: string) {
    const pending = pendingConfigRef.current;
    setModelCandidates(null);
    pendingConfigRef.current = null;
    await rememberDefaultVisionConfig(configId);
    if (pending) await startBatchAnalysis(pending.actionId, pending.itemIds);
  }

  async function confirmDraft(draft: DraftView) {
    const suggestion = suggestions[draft.id];
    const category = pickedCategories[draft.id] ?? suggestion?.category;
    if (!category) {
      toast('请先选择品类');
      return;
    }
    // 用户改过就用用户的（含主动清空），否则用分析建议的名称
    const name = names[draft.id] ?? suggestion?.name;
    await confirmItem(draft.id, { category, name });
    setDrafts((prev) => prev.filter((item) => item.id !== draft.id));
    draftIdsRef.current = draftIdsRef.current.filter((id) => id !== draft.id);
    notifyAnalysisChanged();
    toast('已入库，尺寸和细节以后再补');
  }

  function analysisHint(suggestion: DraftSuggestion | undefined): string {
    if (!suggestion) return '正在分析…';
    if (suggestion.status === 'queued' || suggestion.status === 'running') return '正在分析…';
    if (suggestion.hasResult) return '已按照片给出建议，可核对后确认';
    if (suggestion.status === 'succeeded') return '照片不够清楚，建议换一张更清晰的单品照';
    if (suggestion.status === null) return '尚未分析';
    return '本次分析未完成，可稍后重试';
  }

  function renderDraft(draft: DraftView) {
    const suggestion = suggestions[draft.id];
    const activeCategory = pickedCategories[draft.id] ?? suggestion?.category;
    const nameValue = names[draft.id] ?? suggestion?.name ?? '';
    return (
      <View key={draft.id} style={styles.draftCard}>
        {draft.thumbUri ? (
          <Image source={{ uri: draft.thumbUri }} style={styles.draftImage} resizeMode="cover" />
        ) : (
          <View style={[styles.draftImage, styles.draftPlaceholder]} />
        )}
        <View style={styles.draftBody}>
          <TextField
            value={nameValue}
            onChangeText={(text) => setNames((prev) => ({ ...prev, [draft.id]: text }))}
            placeholder="名称（可选）"
            maxLength={30}
          />
          <Text style={styles.analysisHint}>{analysisHint(suggestion)}</Text>
          <View style={styles.categoryRow}>
            <Text style={styles.categoryLabel}>品类（必选）</Text>
          </View>
          <View style={styles.chipRow}>
            {categories.map((category) => (
              <Button
                key={category}
                variant="chip"
                label={category}
                active={activeCategory === category}
                onPress={() => setPickedCategories((prev) => ({ ...prev, [draft.id]: category }))}
              />
            ))}
          </View>
          <Button
            variant="primary"
            label="确认入库"
            onPress={() => confirmDraft(draft)}
            style={styles.confirmGap}
          />
        </View>
      </View>
    );
  }

  return (
    <Page>
      <BackTitle title="添加一件衣服" onBack={() => router.back()} />
      <Text style={styles.stepTop}>先有照片，其他慢慢来。</Text>
      <Text style={[type.titleXL, styles.title]}>从这一件开始。</Text>
      <Text style={styles.subtitle}>不用找尺子，也不用填写一整张表。</Text>

      {drafts.length === 0 ? (
        <>
          <Button
            variant="primary"
            icon="camera"
            label="拍照入库"
            onPress={takePhoto}
            disabled={busy}
            style={styles.uploadGap}
          />
          <Button
            variant="secondary"
            icon="image"
            label="从相册选择（可多选）"
            onPress={pickFromLibrary}
            disabled={busy}
            style={styles.full}
          />
          <Text style={styles.subtleInfo}>
            {'照片保存在本机；只有在你配置了图片理解模型时，才会为分析把这一件的照片发送到你选择的服务。\n品类可以手动确认，也可以参考分析建议后确认。'}
          </Text>
        </>
      ) : (
        <>
          <Notice>{`有 ${drafts.length} 份草稿待确认。确认品类即入库；不确认的草稿会一直保留，随时回来继续。`}</Notice>
          {drafts.map(renderDraft)}
          <Button variant="primary" label="完成，回衣橱" onPress={() => router.back()} style={styles.full} />
        </>
      )}

      <VisionModelSheet
        visible={modelCandidates !== null}
        candidates={modelCandidates ?? []}
        onSelect={(configId) => void selectModel(configId)}
        onClose={() => setModelCandidates(null)}
      />
    </Page>
  );
}

const styles = StyleSheet.create({
  stepTop: {
    ...type.footnote,
    color: colors.muted,
    marginTop: 17,
  },
  title: {
    color: colors.ink,
    marginTop: 8,
  },
  subtitle: {
    fontSize: 12,
    lineHeight: 19,
    color: colors.muted,
    marginTop: 6,
  },
  uploadGap: {
    marginTop: 20,
  },
  full: {
    alignSelf: 'stretch',
    marginTop: 10,
  },
  subtleInfo: {
    ...type.footnote,
    lineHeight: 20,
    color: colors.subtleInfo,
    marginTop: 15,
    textAlign: 'center',
  },
  draftCard: {
    flexDirection: 'row',
    gap: 12,
    padding: 12,
    borderRadius: radius.notice,
    backgroundColor: colors.soft,
    marginBottom: 12,
  },
  draftImage: {
    width: 96,
    height: 96,
    borderRadius: radius.small,
    backgroundColor: colors.artBg,
  },
  draftPlaceholder: {
    backgroundColor: colors.line,
  },
  draftBody: {
    flex: 1,
    minWidth: 0,
  },
  analysisHint: {
    ...type.footnote,
    color: colors.muted,
    marginTop: 6,
  },
  categoryRow: {
    marginTop: 10,
    marginBottom: 2,
  },
  categoryLabel: {
    fontSize: 12,
    lineHeight: 18,
    color: colors.ink,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 6,
  },
  confirmGap: {
    marginTop: 10,
  },
});

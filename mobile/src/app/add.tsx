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
import { addExtraPhotoToItem, listPhotosForItem, MAX_ITEM_PHOTOS, photoUri } from '../data/repositories/photoRepository';
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
import { categories, type ItemCategory } from '../domain/categories';
import { colors, radius, type } from '../ui/tokens';

// 添加一件衣服：拍照/相册多选 → 每张自动建草稿 → 自动排队做衣物分析：
// - 用户未手动填写数据时，分析成功识别出单品与品类后自动入库（AI 推断来源可追溯）；
// - 未配置模型、分析失败或无法识别单品/品类时保留为草稿，支持手动填写并确认入库；
// - 用户手动填写的名称与品类优先，AI 不覆盖人工输入。

interface DraftView extends WardrobeItem {
  thumbUri: string | null;
  photoCount: number;
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
  /** 本次会话中经模型分析自动入库的单品（供界面反馈，避免卡片直接消失让用户困惑） */
  const [autoSaved, setAutoSaved] = useState<DraftView[]>([]);
  /** 用户输入的名称（只有用户改过才有键；空字符串表示用户主动清空） */
  const [names, setNames] = useState<Record<string, string>>({});
  /** 用户选择的品类（只有用户点过才有键） */
  const [pickedCategories, setPickedCategories] = useState<Record<string, ItemCategory>>({});
  const [suggestions, setSuggestions] = useState<Record<string, DraftSuggestion>>({});
  const [modelCandidates, setModelCandidates] = useState<ModelConfig[] | null>(null);
  const [busy, setBusy] = useState(false);

  const draftIdsRef = useRef<string[]>([]);
  const namesRef = useRef<Record<string, string>>({});
  const pickedCategoriesRef = useRef<Record<string, ItemCategory>>({});
  /** 等待用户选择/配置模型的批次：返回录入页时据此续接 */
  const pendingConfigRef = useRef<{ actionId: string; itemIds: string[] } | null>(null);
  const resumedActionRef = useRef<string | null>(null);

  useEffect(() => {
    namesRef.current = names;
  }, [names]);

  useEffect(() => {
    pickedCategoriesRef.current = pickedCategories;
  }, [pickedCategories]);

  const refreshSuggestions = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;
    const next: Record<string, DraftSuggestion> = {};
    const newlyAutoSaved: DraftView[] = [];
    for (const id of ids) {
      const [item, view] = await Promise.all([getItem(id), getAnalysisView(id)]);
      if (
        item &&
        item.status === 'active' &&
        namesRef.current[id] === undefined &&
        pickedCategoriesRef.current[id] === undefined
      ) {
        const [thumbUri, photos] = await Promise.all([getMainThumb(id), listPhotosForItem(id)]);
        newlyAutoSaved.push({
          ...item,
          thumbUri: thumbUri ? photoUri(thumbUri) : null,
          photoCount: Math.max(1, photos.length),
        });
        continue;
      }
      // 视图已按“人工优先、取当前照片最新成功结果”的规则组装，页面不自行拼接多次输出
      const entry: DraftSuggestion = {
        hasResult: view.lastValidResult !== null,
        status: view.latestTask?.status ?? null,
      };
      // 名称/品类建议来自最新有效结果（内置字段）；用户未编辑时才预填
      if (view.suggestedName?.value) entry.name = view.suggestedName.value;
      if (view.category?.value) entry.category = view.category.value as ItemCategory;
      next[id] = entry;
    }
    if (Object.keys(next).length > 0) {
      setSuggestions((prev) => ({ ...prev, ...next }));
    }
    if (newlyAutoSaved.length > 0) {
      const movedIds = new Set(newlyAutoSaved.map((item) => item.id));
      draftIdsRef.current = draftIdsRef.current.filter((id) => !movedIds.has(id));
      setDrafts((prev) => prev.filter((item) => !movedIds.has(item.id)));
      setAutoSaved((prev) => {
        const existingIds = new Set(prev.map((item) => item.id));
        const additions = newlyAutoSaved.filter((item) => !existingIds.has(item.id));
        return additions.length > 0 ? [...additions, ...prev] : prev;
      });
      if (newlyAutoSaved.length === 1) {
        const one = newlyAutoSaved[0];
        const label = one.name ? `${one.name}（${one.category ?? '未分类'}）` : (one.category ?? '衣物');
        toast(`分析完成，已自动入库：${label}`);
      } else {
        toast(`分析完成，已自动入库 ${newlyAutoSaved.length} 件`);
      }
    }
  }, [toast]);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      (async () => {
        const ids = await listItemIdsByStatus('draft');
        const views: DraftView[] = [];
        for (const id of ids) {
          // 读真实草稿记录（含 revision 等字段），不要用假值拼装 WardrobeItem
          const [item, thumbUri, photos] = await Promise.all([getItem(id), getMainThumb(id), listPhotosForItem(id)]);
          if (!item) continue;
          views.push({ ...item, thumbUri: thumbUri ? photoUri(thumbUri) : null, photoCount: Math.max(1, photos.length) });
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
          const view: DraftView = { ...item, thumbUri: thumbUri ? photoUri(thumbUri) : null, photoCount: 1 };
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
        toast(created > 1 ? `已存入 ${created} 份草稿，正在自动分析并入库` : '已存入草稿，正在自动分析并入库');
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
    if (!suggestion) return '正在分析，未填写时将自动入库…';
    if (suggestion.status === 'queued' || suggestion.status === 'running') return '正在分析，未填写时将自动入库…';
    if (suggestion.hasResult) return '已按照片给出建议，可核对后确认';
    if (suggestion.status === 'succeeded') return '照片不够清楚或未识别出单品品类，请手动选择品类入库';
    if (suggestion.status === null) return '尚未分析，可手动选择品类入库';
    return '本次分析未完成，可手动选择品类或稍后重试';
  }

  async function addExtraPhotosForDraft(draft: DraftView) {
    if (busy) return;
    if (draft.photoCount >= MAX_ITEM_PHOTOS) {
      toast(`同一件衣服最多保存 ${MAX_ITEM_PHOTOS} 张照片`);
      return;
    }
    const remaining = MAX_ITEM_PHOTOS - draft.photoCount;
    Alert.alert('为这件衣服补充照片', '可补充背面、领口或面料细节照（同一件衣服，不会新建草稿）。', [
      { text: '取消', style: 'cancel' },
      {
        text: '拍照补充',
        onPress: () => {
          void (async () => {
            const perm = await ImagePicker.requestCameraPermissionsAsync();
            if (!perm.granted) {
              toast('相机权限被拒绝，可改用相册补充');
              return;
            }
            const res = await ImagePicker.launchCameraAsync({ quality: 1, exif: false });
            if (res.canceled || !res.assets?.length) return;
            const asset = res.assets[0];
            try {
              await addExtraPhotoToItem(draft.id, {
                sourceUri: asset.uri,
                sourceWidth: asset.width,
                sourceHeight: asset.height,
              });
              setDrafts((prev) =>
                prev.map((d) => (d.id === draft.id ? { ...d, photoCount: d.photoCount + 1 } : d)),
              );
              toast('已补充 1 张同件照片');
            } catch (error) {
              toast(`补充失败：${error instanceof Error ? error.message : String(error)}`);
            }
          })();
        },
      },
      {
        text: '从相册选择',
        onPress: () => {
          void (async () => {
            const res = await ImagePicker.launchImageLibraryAsync({
              allowsMultipleSelection: true,
              selectionLimit: remaining,
              quality: 1,
              exif: false,
            });
            if (res.canceled || !res.assets?.length) return;
            let added = 0;
            for (const asset of res.assets) {
              try {
                await addExtraPhotoToItem(draft.id, {
                  sourceUri: asset.uri,
                  sourceWidth: asset.width,
                  sourceHeight: asset.height,
                });
                added += 1;
              } catch (error) {
                toast(`补充失败：${error instanceof Error ? error.message : String(error)}`);
                break;
              }
            }
            if (added > 0) {
              setDrafts((prev) =>
                prev.map((d) => (d.id === draft.id ? { ...d, photoCount: d.photoCount + added } : d)),
              );
              toast(`已补充 ${added} 张同件照片`);
            }
          })();
        },
      },
    ]);
  }

  function renderDraft(draft: DraftView) {
    const suggestion = suggestions[draft.id];
    const activeCategory = pickedCategories[draft.id] ?? suggestion?.category;
    const nameValue = names[draft.id] ?? suggestion?.name ?? '';
    return (
      <View key={draft.id} style={styles.draftCard}>
        <View style={styles.draftMedia}>
          {draft.thumbUri ? (
            <Image source={{ uri: draft.thumbUri }} style={styles.draftImage} resizeMode="cover" />
          ) : (
            <View style={[styles.draftImage, styles.draftPlaceholder]} />
          )}
          <Text style={styles.photoCountText}>{`共 ${draft.photoCount} 张`}</Text>
          {draft.photoCount < MAX_ITEM_PHOTOS ? (
            <Button
              variant="chip"
              label="+ 补图"
              onPress={() => void addExtraPhotosForDraft(draft)}
              style={styles.extraBtn}
            />
          ) : null}
        </View>
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

      {drafts.length === 0 && autoSaved.length === 0 ? (
        <>
          <View style={styles.guideCard}>
            <Text style={styles.guideTitle}>示例照片拍摄建议（提升识别与试穿还原度）</Text>
            <Text style={styles.guideText}>
              {'• 平整平铺或衣架挂拍，自然白光，背景干净并与衣服颜色有反差\n• 完整展开领口、袖子、下摆与图案（鞋履建议侧面 45° 单双照）\n• 尽量不要用他人上身全身照当主图，以免干扰试穿人物与搭配\n• 同一件衣服支持多张照片：入库时或详情页均可补拍背面与面料细节'}
            </Text>
          </View>
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
            {'照片保存在本机；已配置视觉理解模型且未手动填写数据时，分析完成后会自动入库。\n未配置模型或分析未能识别时保留草稿，可手动选择品类确认入库。'}
          </Text>
        </>
      ) : (
        <>
          {drafts.length > 0 ? (
            <>
              <Notice>{`有 ${drafts.length} 份草稿待处理。未填写数据时，模型分析完成后会自动入库；也可直接手动填写并确认。`}</Notice>
              {drafts.map(renderDraft)}
            </>
          ) : null}
          {autoSaved.length > 0 ? (
            <>
              <Notice>{`已自动分析入库 ${autoSaved.length} 件（可在衣橱详情随时修改或确认 AI 识别结果）。`}</Notice>
              {autoSaved.map((item) => (
                <View key={item.id} style={styles.autoSavedCard}>
                  {item.thumbUri ? (
                    <Image source={{ uri: item.thumbUri }} style={styles.autoSavedImage} resizeMode="cover" />
                  ) : (
                    <View style={[styles.autoSavedImage, styles.draftPlaceholder]} />
                  )}
                  <View style={styles.autoSavedBody}>
                    <Text style={styles.autoSavedTitle}>{item.name || item.category || '已入库单品'}</Text>
                    <Text style={styles.autoSavedMeta}>
                      {`已自动入库 · ${item.category ?? '未分类'} · AI 识别`}
                    </Text>
                  </View>
                </View>
              ))}
            </>
          ) : null}
          <Button
            variant="secondary"
            icon="camera"
            label="继续拍照入库"
            onPress={takePhoto}
            disabled={busy}
            style={styles.full}
          />
          <Button
            variant="secondary"
            icon="image"
            label="继续从相册选择"
            onPress={pickFromLibrary}
            disabled={busy}
            style={styles.full}
          />
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
    marginTop: 14,
  },
  guideCard: {
    marginTop: 16,
    padding: 12,
    borderRadius: radius.notice,
    backgroundColor: colors.soft,
    borderWidth: 1,
    borderColor: colors.line,
  },
  guideTitle: {
    ...type.sectionHead,
    color: colors.ink,
    marginBottom: 6,
  },
  guideText: {
    ...type.footnote,
    color: colors.muted,
    lineHeight: 19,
  },
  draftMedia: {
    width: 96,
    alignItems: 'center',
  },
  photoCountText: {
    ...type.footnote,
    color: colors.muted,
    marginTop: 4,
  },
  extraBtn: {
    marginTop: 4,
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
  autoSavedCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 10,
    borderRadius: radius.notice,
    backgroundColor: colors.soft,
    marginBottom: 10,
  },
  autoSavedImage: {
    width: 56,
    height: 56,
    borderRadius: radius.small,
    backgroundColor: colors.artBg,
  },
  autoSavedBody: {
    flex: 1,
    minWidth: 0,
  },
  autoSavedTitle: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '500',
    color: colors.ink,
  },
  autoSavedMeta: {
    ...type.footnote,
    color: colors.tagText,
    marginTop: 3,
  },
});

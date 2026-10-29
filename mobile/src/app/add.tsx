import { useCallback, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { Page } from '../ui/Screen';
import { BackTitle } from '../ui/PageTop';
import { Button } from '../ui/components/Button';
import { Notice } from '../ui/components/Basics';
import { ChipSelect, Field, TextField } from '../ui/components/Field';
import { useToast } from '../ui/components/Toast';
import { photoUri } from '../data/repositories/photoRepository';
import {
  confirmItem,
  createDraftFromPhoto,
  getMainThumb,
  listItemIdsByStatus,
  type WardrobeItem,
} from '../data/repositories/itemRepository';
import { categories, type ItemCategory } from '../data/demo';
import { colors, radius, type } from '../ui/tokens';

// 添加一件衣服（M2 真实版）：拍照/相册多选 → 每张自动建草稿 → 逐件确认品类入库。
// 规则：取消选图不建任何草稿；草稿持久化（重启可恢复）；品类确认前不入库。

interface DraftView extends WardrobeItem {
  thumbUri: string | null;
}

export default function AddScreen() {
  const router = useRouter();
  const toast = useToast();
  const [drafts, setDrafts] = useState<DraftView[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      (async () => {
        const ids = await listItemIdsByStatus('draft');
        const views: DraftView[] = [];
        for (const id of ids) {
          const thumbUri = await getMainThumb(id);
          views.push({
            id,
            status: 'draft',
            category: null,
            name: null,
            sourceType: 'photo',
            mainPhotoId: null,
            thumbUri: thumbUri ? photoUri(thumbUri) : null,
            createdAt: '',
            updatedAt: '',
          });
        }
        if (active) setDrafts(views);
      })();
      return () => {
        active = false;
      };
    }, []),
  );

  // 选图 → 逐张建草稿（任何一张失败即中止并提示，已建的草稿保留——不丢已选内容）
  async function pickAndCreate(picker: () => Promise<ImagePicker.ImagePickerResult>) {
    if (busy) return;
    setBusy(true);
    try {
      const result = await picker();
      if (result.canceled || !result.assets?.length) return; // 取消：不建草稿

      let created = 0;
      for (const asset of result.assets) {
        const clientRef = `pick-${asset.assetId ?? asset.uri}-${Date.now().toString(36)}`;
        try {
          const item = await createDraftFromPhoto(asset.uri, clientRef, asset.width, asset.height);
          const thumbUri = await getMainThumb(item.id);
          const view: DraftView = { ...item, thumbUri: thumbUri ? photoUri(thumbUri) : null };
          setDrafts((prev) => [...prev, view]);
          created += 1;
        } catch (error) {
          toast(`第 ${created + 1} 张保存失败：${error instanceof Error ? error.message : String(error)}`);
          break;
        }
      }
      if (created > 0) toast(created > 1 ? `已存入 ${created} 份草稿，逐件确认即可入库` : '已存入草稿，确认品类即可入库');
    } finally {
      setBusy(false);
    }
  }

  async function takePhoto() {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      // 验收①：拒绝权限可走替代路径
      toast('相机权限被拒绝，可改用“从相册选择”入库');
      return;
    }
    await pickAndCreate(() =>
      ImagePicker.launchCameraAsync({ quality: 1, exif: false }),
    );
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

  async function confirmDraft(draft: DraftView, category: ItemCategory | undefined) {
    if (!category) {
      toast('请先选择品类');
      return;
    }
    await confirmItem(draft.id, { category, name: names[draft.id] });
    setDrafts((prev) => prev.filter((d) => d.id !== draft.id));
    toast('已入库，尺寸和细节以后再补');
  }

  function renderDraft(draft: DraftView) {
    return (
      <View key={draft.id} style={styles.draftCard}>
        {draft.thumbUri ? (
          <Image source={{ uri: draft.thumbUri }} style={styles.draftImage} resizeMode="cover" />
        ) : (
          <View style={[styles.draftImage, styles.draftPlaceholder]} />
        )}
        <View style={styles.draftBody}>
          <TextField
            value={names[draft.id] ?? ''}
            onChangeText={(text) => setNames((prev) => ({ ...prev, [draft.id]: text }))}
            placeholder="名称（可选）"
            maxLength={30}
          />
          <View style={styles.categoryRow}>
            <Text style={styles.categoryLabel}>品类（必选）</Text>
          </View>
          <CategoryPicker onConfirm={(category) => confirmDraft(draft, category)} />
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
            {'照片仅保存在本机，不会上传。\nAPP 不会自动识别品类，请手动确认。'}
          </Text>
        </>
      ) : (
        <>
          <Notice>{`有 ${drafts.length} 份草稿待确认。确认品类即入库；不确认的草稿会一直保留，随时回来继续。`}</Notice>
          {drafts.map(renderDraft)}
          <Button variant="primary" label="完成，回衣橱" onPress={() => router.back()} style={styles.full} />
        </>
      )}
    </Page>
  );
}

function CategoryPicker({ onConfirm }: { onConfirm: (category: ItemCategory | undefined) => void }) {
  const [selected, setSelected] = useState<ItemCategory | undefined>();
  return (
    <View>
      <View style={styles.chipRow}>
        {categories.map((category) => (
          <Button
            key={category}
            variant="chip"
            label={category}
            active={selected === category}
            onPress={() => setSelected(category)}
          />
        ))}
      </View>
      <Button
        variant="primary"
        label="确认入库"
        onPress={() => onConfirm(selected)}
        style={styles.confirmGap}
      />
    </View>
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

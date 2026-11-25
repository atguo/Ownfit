import { useEffect, useState } from 'react';
import { Alert, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Sheet } from '../../ui/components/Sheet';
import { ChoiceRow } from '../../ui/components/Rows';
import { Notice } from '../../ui/components/Basics';
import { Button } from '../../ui/components/Button';
import { Field, TextField } from '../../ui/components/Field';
import { useToast } from '../../ui/components/Toast';
import { colors, radius, type } from '../../ui/tokens';
import {
  getBodyProfile,
  getPreferences,
  saveBodyProfile,
  saveSceneDefault,
  setPreferences,
} from '../../data/repositories/settingsRepository';
import {
  addPreviewReferencePhoto,
  allReferencePaths,
  getPreviewReference,
  MAX_PERSON_REFERENCE_PHOTOS,
  removePreviewReference,
  removePreviewReferencePhoto,
  setPreviewReferenceKind,
  setPrimaryPreviewReferencePhoto,
  type PreviewReference,
} from '../../data/repositories/previewRepository';
import { photoUri } from '../../data/repositories/photoRepository';
import { resetDemo, setPrefs, useDemoStore } from '../demoStore';
import { prefOptions } from '../../data/demo';

// “我的”页弹层集合（原型 preferences/reference/body/privacy/reset）。
// 偏好自 M2 起持久化到本地数据库（可跳过、长期/当次分离）；
// 文案逐字取自原型，其中“原型/浏览器”等指称按 APP 语境改为“演示版/手机”。

export function PreferencesSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const toast = useToast();
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    if (visible) {
      void getPreferences().then(setSelected);
    }
  }, [visible]);

  return (
    <Sheet visible={visible} title="穿得像自己。" onClose={onClose}>
      <Text style={styles.description}>
        这是长期偏好。今天想换个风格，可以在当次搭配中调整。跳过也可以，随时回来设置。
      </Text>
      {prefOptions.map((option) => (
        <ChoiceRow
          key={option}
          label={option}
          selected={selected.includes(option)}
          onPress={() =>
            setSelected((prev) =>
              prev.includes(option) ? prev.filter((p) => p !== option) : [...prev, option],
            )
          }
        />
      ))}
      <Button
        variant="primary"
        label="保存偏好"
        onPress={async () => {
          await setPreferences(selected);
          setPrefs(selected);
          onClose();
          toast('长期偏好已保存');
        }}
        style={styles.done}
      />
      <Button
        variant="text"
        label="暂不设置"
        onPress={() => {
          onClose();
          toast('已跳过，随时可以回来设置');
        }}
      />
    </Sheet>
  );
}

// 人物参考（支持同一人多张参考照，最多 4 张）：相册选图或拍照，压缩后存本机私有目录；
// 仅在生成上身预览时发送给用户手动配置的图像生成服务，不作他用。
export function ReferenceSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const toast = useToast();
  const [reference, setRef] = useState<PreviewReference | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (visible) {
      void getPreviewReference().then((loaded) => {
        setRef(loaded);
        setSelectedPath(loaded?.path ?? null);
      });
    }
  }, [visible]);

  const paths = reference ? allReferencePaths(reference) : [];
  const activePath = selectedPath && paths.includes(selectedPath) ? selectedPath : (paths[0] ?? null);
  const canAddMore = paths.length < MAX_PERSON_REFERENCE_PHOTOS;

  async function savePickedAssets(assets: ImagePicker.ImagePickerAsset[]) {
    setBusy(true);
    try {
      let latest = reference;
      let added = 0;
      for (const asset of assets) {
        try {
          latest = await addPreviewReferencePhoto({
            sourceUri: asset.uri,
            sourceWidth: asset.width ?? 0,
            sourceHeight: asset.height ?? 0,
          });
          added += 1;
        } catch (error) {
          toast(error instanceof Error ? error.message : '保存失败');
          break;
        }
      }
      if (latest) {
        setRef(latest);
        const nextPaths = allReferencePaths(latest);
        setSelectedPath(nextPaths[nextPaths.length - 1] ?? latest.path);
      }
      if (added > 0) {
        toast(added > 1 ? `已添加 ${added} 张人物参考照（仅存本机）` : '人物参考已保存，仅存本机');
      }
    } finally {
      setBusy(false);
    }
  }

  async function pickFromAlbum() {
    if (!canAddMore) {
      toast(`最多保存 ${MAX_PERSON_REFERENCE_PHOTOS} 张人物参考照`);
      return;
    }
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      toast('需要相册权限才能选择参考照');
      return;
    }
    const remaining = MAX_PERSON_REFERENCE_PHOTOS - paths.length;
    const result = await ImagePicker.launchImageLibraryAsync({
      quality: 1,
      exif: false,
      allowsMultipleSelection: remaining > 1,
      selectionLimit: remaining,
    });
    if (result.canceled || result.assets.length === 0) return;
    await savePickedAssets(result.assets.slice(0, remaining));
  }

  async function takePhoto() {
    if (!canAddMore) {
      toast(`最多保存 ${MAX_PERSON_REFERENCE_PHOTOS} 张人物参考照`);
      return;
    }
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      toast('相机权限被拒绝，可改用从相册选择');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ quality: 1, exif: false });
    if (result.canceled || result.assets.length === 0) return;
    await savePickedAssets([result.assets[0]]);
  }

  async function setPrimary(path: string) {
    setBusy(true);
    try {
      const next = await setPrimaryPreviewReferencePhoto(path);
      setRef(next);
      setSelectedPath(path);
      toast('已设为主参考照');
    } finally {
      setBusy(false);
    }
  }

  async function removeOne(path: string) {
    setBusy(true);
    try {
      const next = await removePreviewReferencePhoto(path);
      setRef(next);
      setSelectedPath(next?.path ?? null);
      toast(next ? '已删除该张参考照' : '已移除全部人物参考');
    } finally {
      setBusy(false);
    }
  }

  function confirmRemoveAll() {
    Alert.alert('移除全部人物参考照？', '所有参考照文件将从本机删除，可随时重新添加。', [
      { text: '取消', style: 'cancel' },
      {
        text: '移除',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            setBusy(true);
            try {
              await removePreviewReference();
              setRef(null);
              setSelectedPath(null);
              toast('已移除全部人物参考');
            } finally {
              setBusy(false);
            }
          })();
        },
      },
    ]);
  }

  // C3：声明参考视角——面部特写 vs 全身照的可用证据不同（脸部照不假定模型知道身材）
  async function chooseKind(kind: 'face' | 'full_body') {
    setBusy(true);
    try {
      await setPreviewReferenceKind(kind);
      const next = await getPreviewReference();
      setRef(next);
      toast(kind === 'face' ? '已标记为面部特写' : '已标记为全身照');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet visible={visible} title="你的参考，由你决定。" onClose={onClose}>
      <Text style={styles.description}>
        {reference
          ? `已保存 ${paths.length}/${MAX_PERSON_REFERENCE_PHOTOS} 张人物参考照（仅存本机私有目录）。支持同一人多张（如正面全身照 + 面部近景照），多图模型会一并参考以提升五官与体型还原度。`
          : '生成上身预览需要你本人的正面照片作参考：只存本机，仅发送给你手动配置的图像生成服务，支持同一人添加多张。'}
      </Text>

      <View style={styles.guideCard}>
        <Text style={styles.guideTitle}>示例参考照拍摄标准（防裁腿、防换脸）</Text>
        <Text style={styles.guideText}>
          {'• 竖屏全身照（2:3 或 3:4）：头顶与脚底留少许空白，镜头齐胸/腰平拍\n• 正面自然站立、双手微离身侧（不抱臂、不插兜、不对镜挡脸）\n• 穿合身简洁的日常打底，避免大羽绒服或廓形外套遮挡真实体型\n• 推荐多张组合：图 1 放正面全身照（设为主参考），图 2 补清晰面部近景照'}
        </Text>
      </View>

      {activePath ? (
        <View style={styles.refGallery}>
          <Image
            source={{ uri: photoUri(activePath) }}
            style={styles.refPreview}
            resizeMode="contain"
            accessibilityLabel="当前选中的人物参考照"
          />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.thumbRow}>
            {paths.map((p, idx) => {
              const isSelected = p === activePath;
              const isPrimary = idx === 0;
              return (
                <Pressable
                  key={p}
                  onPress={() => setSelectedPath(p)}
                  style={[styles.thumbWrap, isSelected && styles.thumbSelected]}>
                  <Image source={{ uri: photoUri(p) }} style={styles.thumbImg} resizeMode="cover" />
                  <Text style={styles.thumbLabel}>{isPrimary ? '主参考' : `图 ${idx + 1}`}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
          <View style={styles.refActions}>
            {activePath !== reference?.path ? (
              <Button
                variant="chip"
                label="设为主参考"
                onPress={() => void setPrimary(activePath)}
                disabled={busy}
              />
            ) : null}
            <Button
              variant="chip"
              label="删除此张"
              onPress={() => void removeOne(activePath)}
              disabled={busy}
            />
          </View>
        </View>
      ) : null}

      {reference ? (
        <View>
          <Text style={styles.kindLabel}>主参考视角（用于生成时如实说明证据范围）：</Text>
          <View style={styles.kindRow}>
            <Button
              variant="chip"
              label="面部特写"
              active={reference.kind === 'face'}
              onPress={() => void chooseKind('face')}
              disabled={busy}
            />
            <Button
              variant="chip"
              label="全身照"
              active={reference.kind === 'full_body'}
              onPress={() => void chooseKind('full_body')}
              disabled={busy}
            />
          </View>
          {reference.kind === 'face' ? (
            <Notice>面部特写只能保留长相；建议再补充一张全身照并设为主参考，以获得更准确的身材比例。</Notice>
          ) : null}
        </View>
      ) : null}

      {canAddMore ? (
        <View style={styles.addRow}>
          <Button
            variant="primary"
            label={busy ? '处理中…' : reference ? `从相册添加（${paths.length}/${MAX_PERSON_REFERENCE_PHOTOS}）` : '从相册选择（可多选）'}
            onPress={() => void pickFromAlbum()}
            disabled={busy}
          />
          <Button
            variant="secondary"
            label="拍照添加"
            onPress={() => void takePhoto()}
            disabled={busy}
            style={styles.full}
          />
        </View>
      ) : (
        <Notice>{`已达到上限（${MAX_PERSON_REFERENCE_PHOTOS} 张），如需更换请先删除其中一张。`}</Notice>
      )}
      {reference ? (
        <Button variant="text" label="清空全部参考照" onPress={confirmRemoveAll} disabled={busy} style={styles.full} />
      ) : null}
      <Button variant="text" label="返回" onPress={onClose} />
    </Sheet>
  );
}

// 身材资料（M6 批次 2，2026-11-03 项目用户决定内测前实现基础录入）：
// 身高/体重选填，只存本机；AI 推荐时作为体型参考织入提示词（不下合身结论）。
// 围度等更多信息暂不收集，照片估计不冒充实测的原则不变。
export function BodySheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const toast = useToast();
  const [height, setHeight] = useState('');
  const [weight, setWeight] = useState('');
  const [hasSaved, setHasSaved] = useState(false);

  useEffect(() => {
    if (visible) {
      void getBodyProfile().then((profile) => {
        setHeight(profile?.heightCm != null ? String(profile.heightCm) : '');
        setWeight(profile?.weightKg != null ? String(profile.weightKg) : '');
        setHasSaved(!!profile);
      });
    }
  }, [visible]);

  /** 解析输入；空值放行，非法/越界返回提示文案 */
  function parseInput(): { heightCm?: number; weightKg?: number } | string {
    const parse = (text: string, min: number, max: number, label: string): number | string | null => {
      const trimmed = text.trim();
      if (!trimmed) return null;
      const value = Number(trimmed);
      if (!Number.isFinite(value) || value < min || value > max) {
        return `${label}需在 ${min}–${max} 之间`;
      }
      return value;
    };
    const heightCm = parse(height, 50, 250, '身高（cm）');
    if (typeof heightCm === 'string') return heightCm;
    const weightKg = parse(weight, 20, 300, '体重（kg）');
    if (typeof weightKg === 'string') return weightKg;
    const result: { heightCm?: number; weightKg?: number } = {};
    if (heightCm != null) result.heightCm = heightCm;
    if (weightKg != null) result.weightKg = weightKg;
    return result;
  }

  async function save() {
    const parsed = parseInput();
    if (typeof parsed === 'string') {
      toast(parsed);
      return;
    }
    const saved = await saveBodyProfile(parsed);
    setHasSaved(!!saved);
    onClose();
    toast(saved ? '身材资料已保存，只存本机' : '已清除身材资料');
  }

  async function clearProfile() {
    await saveBodyProfile({ heightCm: null, weightKg: null });
    setHeight('');
    setWeight('');
    setHasSaved(false);
    toast('已清除身材资料');
  }

  return (
    <Sheet visible={visible} title="用到时，再补充。" onClose={onClose}>
      <Text style={styles.description}>
        身高、体重选填，只存本机；AI 推荐时作为体型参考。不收集围度，也不会用照片估计冒充实测。
      </Text>
      <Field label="身高（cm，选填）">
        <TextField value={height} onChangeText={setHeight} placeholder="例如 170" keyboardType="numeric" />
      </Field>
      <Field label="体重（kg，选填）">
        <TextField value={weight} onChangeText={setWeight} placeholder="例如 60" keyboardType="numeric" />
      </Field>
      {hasSaved ? <Notice>已保存。推荐会把它作为体型参考，但不会给出合身结论。</Notice> : null}
      <Button variant="primary" label="保存" onPress={() => void save()} style={styles.done} />
      {hasSaved ? (
        <Button variant="text" label="清除身材资料" onPress={() => void clearProfile()} style={styles.full} />
      ) : null}
      <Button variant="text" label="返回" onPress={onClose} />
    </Sheet>
  );
}

export function PrivacySheet({
  visible,
  onClose,
  onManageDemo,
}: {
  visible: boolean;
  onClose: () => void;
  onManageDemo: () => void;
}) {
  return (
    <Sheet visible={visible} title="照片与资料留在你的手机。" onClose={onClose}>
      <Text style={styles.description}>
        {'资料与照片保存在本机加密数据库和应用私有目录；只有做衣物分析等 AI 功能时，才会把对应那一件的照片发送到你手动配置的模型服务。'}
      </Text>
      <Text style={styles.description}>
        {'没有云端备份：卸载应用或设备丢失、损坏时，本机资料可能无法找回。系统自带的设备换机与云备份默认不收录本应用的资料目录。'}
      </Text>
      <Button variant="secondary" label="管理演示数据" onPress={onManageDemo} style={styles.full} />
      <Button variant="text" label="返回" onPress={onClose} />
    </Sheet>
  );
}

export function ResetSheet({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const toast = useToast();

  function reset(mode: 'default' | 'newUser') {
    resetDemo(mode);
    onClose();
    if (mode === 'default') toast('已恢复示例数据');
  }

  return (
    <Sheet visible={visible} title="重新体验？" onClose={onClose}>
      <Text style={styles.description}>
        只清空当前运行中的演示收藏、偏好与照片，项目文件不会改变。
      </Text>
      <Button variant="primary" label="恢复初始示例" onPress={() => reset('default')} />
      <Button
        variant="secondary"
        label="体验首次空衣橱"
        onPress={() => reset('newUser')}
        style={styles.full}
      />
      <Button variant="text" label="取消" onPress={onClose} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  description: {
    ...type.caption,
    color: colors.muted,
    lineHeight: 23,
    marginBottom: 15,
  },
  done: {
    marginTop: 15,
  },
  full: {
    alignSelf: 'stretch',
    marginTop: 10,
  },
  kindLabel: {
    ...type.footnote,
    color: colors.muted,
    marginTop: 4,
    marginBottom: 6,
  },
  kindRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  guideCard: {
    padding: 12,
    borderRadius: radius.notice,
    backgroundColor: colors.soft,
    borderWidth: 1,
    borderColor: colors.line,
    marginBottom: 12,
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
  refGallery: {
    marginBottom: 12,
  },
  refPreview: {
    width: '100%',
    height: 220,
    borderRadius: radius.small,
    backgroundColor: colors.artBg,
    marginBottom: 8,
  },
  thumbRow: {
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 2,
  },
  thumbWrap: {
    width: 64,
    alignItems: 'center',
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 3,
    backgroundColor: colors.soft,
  },
  thumbSelected: {
    borderColor: colors.green,
    borderWidth: 2,
  },
  thumbImg: {
    width: 56,
    height: 56,
    borderRadius: 6,
    backgroundColor: colors.artBg,
  },
  thumbLabel: {
    fontSize: 10,
    lineHeight: 14,
    color: colors.muted,
    marginTop: 2,
  },
  refActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  addRow: {
    marginTop: 6,
  },
});

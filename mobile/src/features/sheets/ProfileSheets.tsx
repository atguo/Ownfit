import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Sheet } from '../../ui/components/Sheet';
import { ChoiceRow } from '../../ui/components/Rows';
import { Notice } from '../../ui/components/Basics';
import { Button } from '../../ui/components/Button';
import { Field, TextField } from '../../ui/components/Field';
import { useToast } from '../../ui/components/Toast';
import { colors, type } from '../../ui/tokens';
import {
  getBodyProfile,
  getPreferences,
  saveBodyProfile,
  saveSceneDefault,
  setPreferences,
} from '../../data/repositories/settingsRepository';
import {
  getPreviewReference,
  removePreviewReference,
  savePreviewReference,
  setPreviewReferenceKind,
  type PreviewReference,
} from '../../data/repositories/previewRepository';
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

// 人物参考（M5 真实版）：相册选肖像照，压缩后存本机私有目录；
// 仅在生成上身预览时发送给用户手动配置的图像生成服务，不作他用。
export function ReferenceSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const toast = useToast();
  const [reference, setRef] = useState<PreviewReference | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (visible) void getPreviewReference().then(setRef);
  }, [visible]);

  async function pick() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      toast('需要相册权限才能选择参考照');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      quality: 1,
      exif: false,
      allowsMultipleSelection: false,
    });
    if (result.canceled || result.assets.length === 0) return;
    const asset = result.assets[0];
    setBusy(true);
    try {
      const saved = await savePreviewReference({
        sourceUri: asset.uri,
        sourceWidth: asset.width ?? 0,
        sourceHeight: asset.height ?? 0,
      });
      setRef(saved);
      toast('人物参考已保存，仅存本机');
    } catch (error) {
      toast(`保存失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await removePreviewReference();
      setRef(null);
      toast('已移除人物参考');
    } finally {
      setBusy(false);
    }
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
          ? '已保存人物参考照（仅存本机私有目录）。生成上身预览时，才会把它发送到你手动配置的图像生成服务。'
          : '生成上身预览需要一张你本人的正面照片作参考：只存本机，仅发送给你手动配置的图像生成服务，不作他用。'}
      </Text>
      {reference ? (
        <Notice>{`已准备（${reference.updatedAt.slice(0, 10)}）。更换会覆盖旧参考并使旧预览过时。`}</Notice>
      ) : null}
      {reference ? (
        <View>
          <Text style={styles.kindLabel}>这张参考是（用于生成时如实说明证据范围）：</Text>
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
            <Notice>面部特写只能保留长相；生成图的身材比例由模型推断，可能与本人不同，不会用于合身判断。</Notice>
          ) : null}
        </View>
      ) : null}
      <Button
        variant="primary"
        label={busy ? '处理中…' : reference ? '更换参考照' : '从相册选择'}
        onPress={() => void pick()}
        disabled={busy}
      />
      {reference ? (
        <Button variant="text" label="移除参考照" onPress={() => void remove()} disabled={busy} style={styles.full} />
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
});

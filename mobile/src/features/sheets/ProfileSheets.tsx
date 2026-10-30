import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Sheet } from '../../ui/components/Sheet';
import { ChoiceRow } from '../../ui/components/Rows';
import { Notice } from '../../ui/components/Basics';
import { Button } from '../../ui/components/Button';
import { useToast } from '../../ui/components/Toast';
import { colors, type } from '../../ui/tokens';
import { getPreferences, saveSceneDefault, setPreferences } from '../../data/repositories/settingsRepository';
import {
  getPreviewReference,
  removePreviewReference,
  savePreviewReference,
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

export function BodySheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  return (
    <Sheet visible={visible} title="用到时，再补充。" onClose={onClose}>
      <Text style={styles.description}>
        衣橱录入不要求身高、体重或围度。本演示未接入合身判断，不收集这些数据。
      </Text>
      <Notice>真实功能会在判断对应部位时说明需要什么资料，照片估计不会冒充实测。</Notice>
      <Button variant="primary" label="知道了" onPress={onClose} />
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
});

import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Sheet } from '../../ui/components/Sheet';
import { ChoiceRow } from '../../ui/components/Rows';
import { Notice } from '../../ui/components/Basics';
import { Button } from '../../ui/components/Button';
import { useToast } from '../../ui/components/Toast';
import { colors, type } from '../../ui/tokens';
import { getPreferences, saveSceneDefault, setPreferences } from '../../data/repositories/settingsRepository';
import { resetDemo, setPrefs, setReference, useDemoStore } from '../demoStore';
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

export function ReferenceSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { reference } = useDemoStore();
  const toast = useToast();

  return (
    <Sheet visible={visible} title="你的参考，由你决定。" onClose={onClose}>
      <Text style={styles.description}>
        演示版只使用虚构模特，不需要上传你的脸部或身体照片。
      </Text>
      <Button
        variant="primary"
        label={reference ? '移除演示参考' : '使用演示参考'}
        onPress={() => {
          setReference(!reference);
          onClose();
          toast('人物参考状态已更新');
        }}
      />
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

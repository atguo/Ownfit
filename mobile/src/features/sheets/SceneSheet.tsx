import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Sheet } from '../../ui/components/Sheet';
import { Field, ChipSelect, TextField } from '../../ui/components/Field';
import { Notice } from '../../ui/components/Basics';
import { Button } from '../../ui/components/Button';
import { useToast } from '../../ui/components/Toast';
import { setContext, useDemoStore } from '../demoStore';
import { saveSceneDefault } from '../../data/repositories/settingsRepository';
import { dayOptions, sceneOptions } from '../../data/demo';
import { colors, type } from '../../ui/tokens';

// 调整当天场景（天气文档 §4.1）：常用场景只是默认值，当次调整不自动覆盖长期默认——
// 因此“用于这次搭配”只写当次；“保存为常用”才写默认值（用户明确选择）。

export function SceneSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { context } = useDemoStore();
  const toast = useToast();
  const [city, setCity] = useState(context.city);
  const [day, setDay] = useState(context.day);
  const [scene, setScene] = useState(context.scene);

  function applyToCurrent() {
    setContext({ city: city.trim() || '未设置地点', day, scene });
    onClose();
    toast('已更新当次场景；天气仍为演示值');
  }

  async function saveAsDefault() {
    await saveSceneDefault({ city: city.trim() || '未设置地点', day, scene });
    setContext({ city: city.trim() || '未设置地点', day, scene });
    onClose();
    toast('已保存为常用场景');
  }

  return (
    <Sheet visible={visible} title="今天，要去哪里？" onClose={onClose}>
      <Text style={styles.description}>只调整本次搭配，不改变长期偏好。</Text>
      <Field label="地点">
        <TextField value={city} maxLength={20} onChangeText={setCity} placeholder="所在地点" />
      </Field>
      <Field label="日期">
        <ChipSelect options={dayOptions} value={day} onChange={setDay} />
      </Field>
      <Field label="场景">
        <ChipSelect options={sceneOptions} value={scene} onChange={setScene} />
      </Field>
      <Notice>天气为固定演示值 18–24℃，不随地点改变，也不是实时预报。</Notice>
      <Button variant="primary" label="用于这次搭配" onPress={applyToCurrent} />
      <Button variant="secondary" label="保存为常用场景" onPress={saveAsDefault} style={styles.gap} />
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
  gap: {
    alignSelf: 'stretch',
    marginTop: 10,
  },
});

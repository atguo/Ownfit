// 选配色弹层（评估 §8.8，2026-11-04）：恢复原重构计划承诺的搭配页颜色库多选入口。
// 定位：当前会话的挑色软提示——可多选、可清除、退出即弃（会话态），不设为每日必填；
// 不参与推荐/预览请求（不发送给 AI），是否参与后续推荐需按明确语义另行接入，
// 因此这里如实标注"仅作挑色参考"。空颜色库不阻断（颜色库随衣物颜色确认自动积累）。

import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Sheet } from '../../ui/components/Sheet';
import { Button } from '../../ui/components/Button';
import { Notice } from '../../ui/components/Basics';
import { getColorLibrary, type ColorEntry } from '../../data/repositories/colorLibraryRepository';
import { setColorHints, useOutfitSession } from '../outfitSession';
import { colors, type } from '../../ui/tokens';

export function ColorHintSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const session = useOutfitSession();
  const [library, setLibrary] = useState<ColorEntry[] | null>(null);
  const [selected, setSelected] = useState<string[]>(session.colorHints);

  useEffect(() => {
    if (!visible) return;
    setSelected([...session.colorHints]);
    void getColorLibrary().then(setLibrary);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  function toggle(name: string) {
    setSelected((current) =>
      current.includes(name) ? current.filter((n) => n !== name) : [...current, name].slice(0, 8),
    );
  }

  function apply() {
    setColorHints(selected);
    onClose();
  }

  return (
    <Sheet visible={visible} title="选配色" onClose={onClose}>
      <Notice>
        从你的颜色库挑几个这次的参考色（可多选、可清除）。这只是当次的挑色参考，不会发送给 AI，也不会改变推荐规则。
      </Notice>
      {library === null ? (
        <Text style={styles.note}>载入中…</Text>
      ) : library.length === 0 ? (
        <Text style={styles.note}>
          颜色库还是空的：在衣物详情里确认颜色后会自动积累，到时候可以从这里挑。
        </Text>
      ) : (
        <View style={styles.chipWrap}>
          {library.map((color) => {
            const active = selected.includes(color.name);
            return (
              <Button
                key={`${color.hex}-${color.name}`}
                variant="chip"
                label={color.name}
                active={active}
                onPress={() => toggle(color.name)}
                style={styles.chip}
              />
            );
          })}
        </View>
      )}
      <View style={styles.actions}>
        <Button
          variant="secondary"
          label={`就这样选（${selected.length}）`}
          onPress={apply}
          disabled={library !== null && library.length === 0 && selected.length === 0}
        />
        <Button
          variant="text"
          label="清除已选"
          onPress={() => {
            setSelected([]);
            setColorHints([]);
          }}
          disabled={selected.length === 0 && session.colorHints.length === 0}
        />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  note: {
    ...type.footnote,
    color: colors.muted,
    lineHeight: 18,
    marginTop: 4,
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 8,
  },
  chip: {
    // 由 wrap + gap 排布
  },
  actions: {
    gap: 8,
    marginTop: 12,
  },
});

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Sheet } from '../../ui/components/Sheet';
import { Notice } from '../../ui/components/Basics';
import { Button } from '../../ui/components/Button';
import { ItemArt } from '../../ui/components/ItemArt';
import { useToast } from '../../ui/components/Toast';
import { colors, type } from '../../ui/tokens';
import { getItem, outfitEdit, useDemoStore } from '../demoStore';

// 替换一件单品（原型 replace/apply-replace）：同品类候选，点击即替换；
// 上衣替换换 top，基础单品替换换 select，其余品类 M1 未纳入（原型一致）。

export function ReplaceSheet({
  targetId,
  onClose,
  onGoAdd,
}: {
  targetId: string | null;
  onClose: () => void;
  onGoAdd: () => void;
}) {
  const { items, select, locks } = useDemoStore();
  const toast = useToast();
  const target = targetId ? getItem(targetId) : null;
  const choices = target ? items.filter((x) => x.cat === target.cat && x.id !== target.id) : [];

  function applyReplace(newId: string) {
    if (!target) return;
    if (locks.includes(target.id)) {
      toast('这件单品已锁定');
      return;
    }
    if (getItem(newId)?.cat === '上衣') {
      outfitEdit({ top: newId });
      onClose();
      toast('已替换一件，其他锁定单品保持不变');
    } else if (target.id === select) {
      outfitEdit({ select: newId });
      onClose();
      toast('已替换一件，其他锁定单品保持不变');
    } else {
      toast('这个品类的替换尚未纳入原型');
    }
  }

  return (
    <Sheet visible={target != null} title="只换这一件。" onClose={onClose}>
      <Text style={styles.description}>其他锁定单品保持不变。</Text>
      {target && choices.length > 0 ? (
        <View style={styles.grid}>
          {choices.map((choice) => (
            <Pressable
              key={choice.id}
              accessibilityRole="button"
              accessibilityLabel={`替换为${choice.name}`}
              onPress={() => applyReplace(choice.id)}
              style={({ pressed }) => [styles.cell, pressed && styles.cellPressed]}>
              <ItemArt x={choice.x} y={choice.y} radius={15} />
              <Text style={styles.cellName}>{choice.name}</Text>
            </Pressable>
          ))}
        </View>
      ) : (
        target && (
          <Notice>
            已录入衣橱里暂时没有其他{target.cat}。这不代表你没有，可以再添加一件。
          </Notice>
        )
      )}
      {target && choices.length === 0 ? (
        <Button variant="primary" label="添加我已有的" onPress={onGoAdd} />
      ) : null}
      <Button variant="text" label="保留原来的搭配" onPress={onClose} />
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
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginVertical: 18,
  },
  cell: {
    width: '47%',
    borderWidth: 2,
    borderColor: 'transparent',
    borderRadius: 15,
    padding: 5,
  },
  cellPressed: {
    borderColor: colors.choiceSelectedBorder,
    backgroundColor: colors.choiceSelectedBg,
  },
  cellName: {
    color: colors.ink,
    fontSize: 12,
    fontWeight: '500',
    lineHeight: 18,
    marginTop: 9,
    marginBottom: 5,
  },
});

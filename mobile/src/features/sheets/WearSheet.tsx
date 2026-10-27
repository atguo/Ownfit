import { StyleSheet, Text } from 'react-native';
import { Sheet } from '../../ui/components/Sheet';
import { ChoiceRow } from '../../ui/components/Rows';
import { useToast } from '../../ui/components/Toast';
import { colors, type } from '../../ui/tokens';
import { outfitEdit, useDemoStore } from '../demoStore';
import { wearOptions } from '../../data/demo';

// 调整穿法（原型 wear/wear-set）：入撤销栈、预览状态重置。

export function WearSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { wear } = useDemoStore();
  const toast = useToast();

  return (
    <Sheet visible={visible} title="小小调整，不同感觉。" onClose={onClose}>
      <Text style={styles.description}>穿法会保存到当前方案。预制示意图不会随穿法变化。</Text>
      {wearOptions.map((option) => (
        <ChoiceRow
          key={option}
          label={option}
          selected={option === wear}
          onPress={() => {
            if (option !== wear) {
              outfitEdit({ wear: option });
              onClose();
              toast('已更新穿法，预览状态已重置');
            } else {
              onClose();
            }
          }}
        />
      ))}
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
});

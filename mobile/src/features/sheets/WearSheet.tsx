// 调整穿法（原型 wear/wear-set）：入撤销栈；保存方案时随方案版本记录。
import { StyleSheet, Text } from 'react-native';
import { Sheet } from '../../ui/components/Sheet';
import { ChoiceRow } from '../../ui/components/Rows';
import { colors, type } from '../../ui/tokens';
import { setWear, useOutfitSession } from '../outfitSession';
import { wearOptions } from '../../data/demo';

export function WearSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { wear } = useOutfitSession();

  return (
    <Sheet visible={visible} title="小小调整，不同感觉。" onClose={onClose}>
      <Text style={styles.description}>穿法会保存到当前方案。预制示意图不会随穿法变化。</Text>
      {wearOptions.map((option) => (
        <ChoiceRow
          key={option}
          label={option}
          selected={option === wear}
          onPress={() => {
            if (option !== wear) setWear(option);
            onClose();
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

// 调整穿法（原型 wear/wear-set）：入撤销栈；保存方案时随方案版本记录。
// C4（2026-11-04，契约 v1.1.0）：组合含外套时逐件设置——内搭穿法与外套穿法可同时表达
// （如"内搭前塞 + 外套敞开"）；无外套时保持原单一清单。预览提示词按件读取。
import { StyleSheet, Text, View } from 'react-native';
import { Sheet } from '../../ui/components/Sheet';
import { ChoiceRow } from '../../ui/components/Rows';
import { colors, type } from '../../ui/tokens';
import { setSlotWear, setWear, useOutfitSession } from '../outfitSession';
import { wearOptions } from '../../data/demo';

/** 内搭/连衣裙可用的穿法（不含"外层敞开穿"——那是外套的表达） */
const BASE_WEAR_OPTIONS = wearOptions.filter((option) => option !== '外层敞开穿');
/** 外套可用的穿法（不含"前侧塞衣角"——塞衣角只适用于内搭） */
const OUTER_WEAR_OPTIONS = wearOptions.filter((option) => option !== '前侧塞衣角');

export function WearSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { wear, slotWear, slots } = useOutfitSession();
  const hasOuter = !!slots.outer;

  return (
    <Sheet visible={visible} title="小小调整，不同感觉。" onClose={onClose}>
      <Text style={styles.description}>穿法会保存到当前方案。预制示意图不会随穿法变化。</Text>
      {hasOuter ? (
        <View>
          <Text style={styles.groupLabel}>内搭穿法</Text>
          {BASE_WEAR_OPTIONS.map((option) => (
            <ChoiceRow
              key={option}
              label={option}
              selected={option === wear}
              onPress={() => {
                setWear(option);
              }}
            />
          ))}
          <Text style={styles.groupLabel}>外套穿法</Text>
          {OUTER_WEAR_OPTIONS.map((option) => (
            <ChoiceRow
              key={option}
              label={option}
              selected={option === (slotWear.outer ?? '自然垂放')}
              onPress={() => {
                setSlotWear('outer', option);
              }}
            />
          ))}
        </View>
      ) : (
        wearOptions.map((option) => (
          <ChoiceRow
            key={option}
            label={option}
            selected={option === wear}
            onPress={() => {
              if (option !== wear) setWear(option);
              onClose();
            }}
          />
        ))
      )}
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
  groupLabel: {
    ...type.footnote,
    color: colors.muted,
    marginTop: 6,
    marginBottom: 4,
  },
});

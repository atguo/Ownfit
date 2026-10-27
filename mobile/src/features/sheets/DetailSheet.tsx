import { StyleSheet, Text, View } from 'react-native';
import { Sheet } from '../../ui/components/Sheet';
import { Tag } from '../../ui/components/Basics';
import { Button } from '../../ui/components/Button';
import { ItemArt } from '../../ui/components/ItemArt';
import { colors, type } from '../../ui/tokens';
import { buildOutfit } from '../demoStore';
import type { DemoItem } from '../../data/demo';

// 衣服详情（原型 detail(id)）：大图 + 结构化摘要 + 围绕这件搭配。
// 详情口径与功能文档一致：来源与确认状态分开呈现，未录入字段显示“未填写”而不虚构。

export function DetailSheet({
  item,
  onClose,
  onUse,
}: {
  item: DemoItem | null;
  onClose: () => void;
  /** 围绕这件搭配：选择该单品并进入搭配 */
  onUse: (id: string) => void;
}) {
  return (
    <Sheet visible={item != null} title={item?.name ?? ''} onClose={onClose}>
      {item ? (
        <>
          <View style={styles.largeArt}>
            <ItemArt x={item.x} y={item.y} radius={13} />
          </View>
      <Tag label="可以用于基础搭配" />
      <View style={styles.detailList}>
        <DetailCell label="品类" value={item.cat} />
        <DetailCell label="颜色" value={item.color || '尚未确认'} />
        <DetailCell label="来源" value="演示资料" />
        <DetailCell label="实测尺寸" value="未填写" />
      </View>
      <Text style={styles.description}>
        需要判断衣长或松紧时，再补相关尺寸。现在也可以先看看怎么搭。
      </Text>
      <Button
        variant="primary"
        label="围绕这件搭配"
        onPress={() => {
          if (buildOutfit(item.id)) onUse(item.id);
        }}
      />
        </>
      ) : null}
    </Sheet>
  );
}

function DetailCell({ label, value }: { label: string; value: string }) {
  return (
    <View>
      <Text style={styles.cellLabel}>{label}</Text>
      <Text style={styles.cellValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  largeArt: {
    width: 215,
    alignSelf: 'center',
    marginTop: 10,
    marginBottom: 20,
  },
  detailList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 14,
    marginVertical: 17,
  },
  cellLabel: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 5,
  },
  cellValue: {
    color: colors.ink,
    fontSize: 12,
    lineHeight: 18,
  },
  description: {
    ...type.caption,
    color: colors.muted,
    lineHeight: 23,
    marginBottom: 15,
  },
});

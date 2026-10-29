// 真实搭配板：按槽位渲染衣橱单品的主图（区别于演示雪碧图板 OutfitBoard）。
// 槽位几何沿用原型 .outfit-board 的三层布局；连衣裙占用上衣槽（最大位）。

import { Image, StyleSheet, Text, View } from 'react-native';
import { Icon } from '../Icon';
import { colors, radius } from '../tokens';

export interface RealBoardSlots {
  top?: string | null; // 上衣或外套（连衣裙复用此槽几何）
  dress?: string | null;
  bottom?: string | null;
  shoes?: string | null;
}

export function RealOutfitBoard({
  slots,
  lockLabel,
  height = 267,
  caption,
}: {
  slots: RealBoardSlots;
  lockLabel?: string;
  height?: number;
  caption?: string;
}) {
  return (
    <View style={[styles.board, { height }]}>
      {slots.top || slots.dress ? (
        <Layer uri={(slots.dress ?? slots.top) as string} style={styles.layerTop} />
      ) : null}
      {slots.bottom ? <Layer uri={slots.bottom} style={styles.layerBottom} /> : null}
      {slots.shoes ? <Layer uri={slots.shoes} style={styles.layerShoes} /> : null}
      {caption ? <Text style={styles.caption}>{caption}</Text> : null}
      {lockLabel ? (
        <View style={styles.lockBadge}>
          <Icon name="lock" size={12} color={colors.ink} />
          <Text style={styles.lockText}>{lockLabel}</Text>
        </View>
      ) : null}
    </View>
  );
}

function Layer({ uri, style }: { uri: string; style: object }) {
  return <Image source={{ uri }} resizeMode="contain" style={[styles.layer, style]} />;
}

const styles = StyleSheet.create({
  board: {
    backgroundColor: colors.boardBg,
    borderRadius: radius.board,
    overflow: 'hidden',
    marginVertical: 14,
  },
  layer: {
    position: 'absolute',
  },
  layerTop: {
    width: '56%',
    height: '62%',
    left: 0,
    top: 2,
  },
  layerBottom: {
    width: '64%',
    height: '58%',
    right: '-2%',
    top: '14%',
  },
  layerShoes: {
    width: '38%',
    height: '24%',
    left: '3%',
    bottom: 0,
  },
  caption: {
    position: 'absolute',
    right: 14,
    bottom: 14,
    color: colors.boardCaption,
    fontSize: 10,
    lineHeight: 14,
  },
  lockBadge: {
    position: 'absolute',
    top: 12,
    right: 12,
    backgroundColor: colors.white,
    borderRadius: radius.pill,
    paddingHorizontal: 9,
    paddingVertical: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  lockText: {
    color: colors.ink,
    fontSize: 10,
    lineHeight: 14,
  },
});

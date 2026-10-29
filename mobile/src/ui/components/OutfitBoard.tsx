import { StyleSheet, Text, View } from 'react-native';
import { Icon } from '../Icon';
import { colors, radius } from '../tokens';
import { demoItems } from '../../data/demo';
import { ItemArt } from './ItemArt';

// 搭配板，对应原型 .outfit-board：上衣/下装/鞋履三层绝对定位 + 右下角注 + 右上角锁定徽标。
// small 态（收藏卡内）高 220、无角注与徽标；常规态高 267。

export function OutfitBoard({
  topId,
  lockLabel,
  small = false,
}: {
  topId: string;
  /** 传入时显示锁定徽标（基础单品名） */
  lockLabel?: string;
  small?: boolean;
}) {
  return (
    <View style={[styles.board, small ? styles.boardSmall : null]}>
      <BoardLayer id={topId} style={styles.layerTop} />
      <BoardLayer id="pants" style={styles.layerPants} />
      <BoardLayer id="shoes" style={styles.layerShoes} />
      {!small && <Text style={styles.caption}>已录入衣橱的组合</Text>}
      {!small && lockLabel && (
        <View style={styles.lockBadge}>
          <Icon name="lock" size={12} color={colors.ink} />
          <Text style={styles.lockText}>{lockLabel}</Text>
        </View>
      )}
    </View>
  );
}

function BoardLayer({ id, style }: { id: string; style: object }) {
  const item = demoItems.find((candidate) => candidate.id === id);
  if (!item) return null;
  // 原型对搭配板内图片使用 mix-blend multiply；RN Android 支持有限，
  // 雪碧图底色与板底色相近，未启用混合时视觉差异可忽略。
  return <ItemArt x={item.x} y={item.y} radius={0} style={style} />;
}

const styles = StyleSheet.create({
  board: {
    height: 267,
    backgroundColor: colors.boardBg,
    borderRadius: radius.board,
    overflow: 'hidden',
    marginVertical: 14,
  },
  boardSmall: {
    height: 220,
    borderRadius: 0,
    marginVertical: 0,
  },
  layerTop: {
    position: 'absolute',
    width: '56%',
    left: 0,
    top: 2,
  },
  layerPants: {
    position: 'absolute',
    width: '64%',
    right: '-2%',
    top: 33,
  },
  layerShoes: {
    position: 'absolute',
    width: '38%',
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

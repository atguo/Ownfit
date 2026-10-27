import { Image, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useState } from 'react';
import { colors } from '../tokens';
import { DemoLabel } from './Basics';

// 单品图与模特图：直接使用原型雪碧图（mobile/assets/demo/），按 background-position 语义裁切。
// 原型 .item-art 是 3 列 × 2 行（background-size 300% 200%，x/y 取 0/50/100 与 0/100）；
// .look-art 是 2 格横排（background-size 200% 100%，--look 取 0/1）。
// RN 无 background-position，用隐藏溢出容器 + 全图拉伸偏移实现同等效果。

interface ItemArtProps {
  x?: number;
  y?: number;
  radius?: number;
  label?: string;
  style?: StyleProp<ViewStyle>;
}

export function ItemArt({ x = 0, y = 0, radius: r = 13, label, style }: ItemArtProps) {
  const [width, setWidth] = useState(0);
  const col = x / 50;
  const row = y / 100;

  return (
    <View
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={[styles.item, { borderRadius: r }, style]}>
      {width > 0 ? (
        <Image
          source={require('../../../assets/demo/wardrobe.png')}
          resizeMode="stretch"
          style={{
            width: width * 3,
            height: width * 2,
            position: 'absolute',
            left: -col * width,
            top: -row * width,
          }}
        />
      ) : null}
      {label ? <DemoLabel label={label} /> : null}
    </View>
  );
}

interface LookArtProps {
  /** 0 或 1：雪碧图左格/右格 */
  look?: number;
  label?: string;
  style?: StyleProp<ViewStyle>;
}

export function LookArt({ look = 0, label, style }: LookArtProps) {
  const [size, setSize] = useState({ width: 0, height: 0 });

  return (
    <View
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
      }}
      style={[styles.look, style]}>
      {size.width > 0 ? (
        <Image
          source={require('../../../assets/demo/looks.png')}
          resizeMode="stretch"
          style={{
            width: size.width * 2,
            height: size.height,
            position: 'absolute',
            left: -look * size.width,
            top: 0,
          }}
        />
      ) : null}
      {label ? <DemoLabel label={label} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  item: {
    alignSelf: 'stretch',
    aspectRatio: 1,
    backgroundColor: colors.artBg,
    overflow: 'hidden',
  },
  look: {
    backgroundColor: colors.heroArtBg,
    overflow: 'hidden',
  },
});

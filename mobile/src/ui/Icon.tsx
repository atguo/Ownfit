import { Svg, Path } from 'react-native-svg';
import { colors } from './tokens';

// 图标 path 与 prototype/app.js 完全一致：24 viewBox、stroke 1.65、round cap/join。
const paths = {
  home: 'M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z',
  closet: 'M9 6a3 3 0 1 1 3 3v2L3 17v3h18v-3l-9-6',
  heart: 'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z',
  user: 'M20 21v-2a7 7 0 0 0-14 0v2M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  plus: 'M12 5v14M5 12h14',
  arrow: 'M5 12h14m-5-5 5 5-5 5',
  back: 'm14 5-7 7 7 7',
  chevron: 'm9 5 7 7-7 7',
  sun: 'M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  lock: 'M6 11h12v10H6ZM8 11V7a4 4 0 0 1 8 0v4m-4 4v2',
  unlock: 'M6 11h12v10H6ZM8 11V7a4 4 0 0 1 7.5-2',
  spark: 'm12 3 2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2Z',
  camera: 'M3 7h4l2-3h6l2 3h4v14H3ZM16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  check: 'm5 12 4 4L19 6',
  close: 'm6 6 12 12M18 6 6 18',
  undo: 'M9 4 4 9l5 5M4 9h10a6 6 0 0 1 0 12',
  swap: 'M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4',
  leaf: 'M20 3C8 3 3 7 5 15s15 5 15-12ZM5 20 16 9',
  grid: 'M3 3h7v7H3ZM14 3h7v7h-7ZM3 14h7v7H3ZM14 14h7v7h-7Z',
  image: 'M3 3h18v18H3Zm0 13 6-6 6 6 3-3 3 3M16 7h.01',
  info: 'M12 8h.01M12 11v6M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  bookmark: 'M6 3h12v18l-6-4-6 4Z',
} as const;

export type IconName = keyof typeof paths;

export function Icon({
  name,
  size = 22,
  color = colors.ink,
}: {
  name: IconName;
  size?: number;
  /** 兼容 react-navigation 传入的 ColorValue（可为 number） */
  color?: string | number;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d={paths[name]}
        stroke={color}
        strokeWidth={1.65}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

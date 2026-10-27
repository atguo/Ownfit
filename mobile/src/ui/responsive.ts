import { useWindowDimensions } from 'react-native';

// 窗口尺寸类别参考 Material 窗口类别：compact <600dp，medium <840dp，expanded ≥840dp。
// 布局一律使用 dp、百分比与弹性布局，不写死像素；文字容器避免固定高度，保证系统字体缩放可用。
// Find X9 Pro（2772×1272，450ppi）约为 compact 类；平板与折叠屏展开态落入 medium/expanded。
export type WindowSizeClass = 'compact' | 'medium' | 'expanded';

export function useWindowSizeClass(): WindowSizeClass {
  const { width } = useWindowDimensions();
  if (width >= 840) return 'expanded';
  if (width >= 600) return 'medium';
  return 'compact';
}

// 内容主列宽度：手机占满，平板/展开态限宽居中，避免大屏拉伸难看。
export function useContentMaxWidth(): number | undefined {
  const sizeClass = useWindowSizeClass();
  if (sizeClass === 'expanded') return 720;
  if (sizeClass === 'medium') return 600;
  return undefined;
}

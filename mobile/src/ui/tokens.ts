// 设计令牌：自 prototype/style.css 逐字提取，原型是 M1 的唯一视觉基准（docs/prototype/README.md）。
// 原型声明“沿用视觉意图，不要求照搬 CSS 尺寸”：dp 数值沿用原型比例，触控目标与安全区域按真机调整。
// 全部布局使用 dp 与弹性布局，文字容器不设固定高度，保证系统字体缩放可用。

export const colors = {
  // :root 基础变量
  bg: '#FAFBF8',
  soft: '#EFF2EC',
  ink: '#25332D',
  green: '#24483E',
  muted: '#747C75',
  line: '#E7EAE5',
  accent: '#A6B3A0',
  white: '#FFFFFF',

  // 原型中的字面派生色
  primaryPress: '#315C4D',
  secondaryBorder: '#DCE2D8',
  focus: '#8BAF99',
  tabInactive: '#858C82',
  tabBg: 'rgba(250,251,248,0.96)',
  homeIndicator: '#26352B',
  artBg: '#F0F1EE',
  boardBg: '#EFF1EC',
  heroBg: '#DFE4DC',
  heroArtBg: '#D8DBD7',
  heroTiny: '#596953',
  heroCopy: '#6D776C',
  heroTagBg: 'rgba(255,255,255,0.65)',
  tagBg: '#E8EEE4',
  tagText: '#537047',
  avatarBg: '#E6ECE1',
  avatarText: '#627957',
  profileAvatarBg: '#DFE8D8',
  profileAvatarText: '#6C805F',
  weatherIcon: '#727E52',
  miniText: '#687368',
  subtleInfo: '#7A8377',
  emptyIcon: '#8D9D86',
  overlay: 'rgba(21,37,29,0.4)',
  sheetShadow: 'rgba(24,51,34,0.11)',
  sheetHandle: '#D9DFD4',
  toastBg: 'rgba(36,61,50,0.95)',
  spinnerTrack: '#DBE4D5',
  choiceSelectedBorder: '#7A9670',
  choiceSelectedBg: '#EDF2E9',
  uploadBorder: '#B5C3AD',
  uploadIcon: '#788D6F',
  inputBorder: '#DDE3D8',
  reasonText: '#697563',
  reasonIcon: '#819270',
  boardCaption: '#6C7566',
  lockedBtnBg: '#E3EBE0',
  lockedBtnText: '#4C6842',
  savedSecondaryBg: '#E5EEE1',
  noticeText: '#6D7667',
  onboardingBg: '#E7EDE1',
  onboardingText: '#6F7D66',
  profileNoteBg: '#EAF0E5',
  demoLabelBg: 'rgba(255,255,255,0.87)',
  demoLabelText: '#5F695E',
  segmentedShadow: 'rgba(32,48,32,0.035)',
  pressSoft: 'rgba(36,72,62,0.06)',
} as const;

// 字阶（dp）。原型 h2 字重 550，RN 取最接近的 500；行高按原型倍率换算为绝对值。
export const type = {
  titleXL: { fontSize: 27, fontWeight: '500', letterSpacing: -0.8, lineHeight: 39 },
  titleLg: { fontSize: 25, fontWeight: '500', letterSpacing: -0.6, lineHeight: 36 },
  titleMd: { fontSize: 21, fontWeight: '500', letterSpacing: -0.5, lineHeight: 30 },
  titleSm: { fontSize: 19, fontWeight: '500', letterSpacing: -0.4, lineHeight: 28 },
  heading: { fontSize: 17, fontWeight: '600', lineHeight: 25 },
  sectionHead: { fontSize: 16, fontWeight: '600', lineHeight: 23 },
  body: { fontSize: 14, lineHeight: 22 },
  secondary: { fontSize: 13, lineHeight: 20 },
  caption: { fontSize: 12, lineHeight: 19 },
  footnote: { fontSize: 11, lineHeight: 18 },
  micro: { fontSize: 10, lineHeight: 16 },
} as const;

// 页面左右留白（原型 .page: 10px 23px 24px）
export const pagePadding = { x: 23, top: 10, bottom: 24 } as const;

export const radius = {
  small: 9,
  notice: 11,
  button: 12,
  buttonLg: 13,
  weather: 15,
  savedCard: 17,
  empty: 18,
  board: 19,
  base: 20,
  hero: 22,
  sheet: 25,
  pill: 999,
} as const;

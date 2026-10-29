// M1 演示数据：与原型 app.js 的 defaults() 一致的内存常量，仅用于 M1 界面实现与视觉对照。
// 不持久化、不代表真实资料；M2 接入本地数据库后整体替换（AGENTS.md 第 4 节规则 5：演示数据隔离）。

export type ItemCategory = '上衣' | '下装' | '连衣裙' | '外套' | '鞋履' | '包' | '配饰';

export interface DemoItem {
  id: string;
  name: string;
  cat: ItemCategory;
  color: string;
  /** prototype/assets/wardrobe.png 雪碧图列偏移（0/50/100 → 第 1/2/3 列） */
  x: number;
  /** 雪碧图行偏移（0/100 → 第 1/2 行） */
  y: number;
}

export const demoItems: DemoItem[] = [
  { id: 'knit', name: '奶油白针织衫', cat: '上衣', color: '奶油白', x: 0, y: 0 },
  { id: 'pants', name: '炭灰色阔腿裤', cat: '下装', color: '炭灰', x: 50, y: 0 },
  { id: 'sage', name: '鼠尾草绿衬衫', cat: '上衣', color: '鼠尾草绿', x: 100, y: 0 },
  { id: 'blue', name: '浅蓝色棉衬衫', cat: '上衣', color: '浅蓝', x: 0, y: 100 },
  { id: 'shoes', name: '黑色乐福鞋', cat: '鞋履', color: '黑色', x: 50, y: 100 },
  { id: 'bag', name: '巧克力肩包', cat: '配饰', color: '巧克力色', x: 100, y: 100 },
];

export const categories: ItemCategory[] = ['上衣', '下装', '连衣裙', '外套', '鞋履', '包', '配饰'];

export const sceneOptions = ['日常通勤', '周末散步', '朋友见面', '全天户外'] as const;
export const dayOptions = ['今天', '明天'] as const;
export const wearOptions = ['自然垂放', '前侧塞衣角', '外层敞开穿'] as const;
export const prefOptions = ['简约日常', '宽松一些', '利落修身', '柔和配色', '不穿高跟鞋'] as const;

// 业务品类类型与全集（2026-11-13 结构收敛：自 data/demo.ts 移入 domain，
// 业务类型唯一出处；demo.ts 仅保留演示数据并自此导入）。
export type ItemCategory = '上衣' | '下装' | '连衣裙' | '外套' | '鞋履' | '包' | '配饰';

export const categories: ItemCategory[] = ['上衣', '下装', '连衣裙', '外套', '鞋履', '包', '配饰'];

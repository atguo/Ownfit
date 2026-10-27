import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Page } from '../../ui/Screen';
import { PageTop } from '../../ui/PageTop';
import { Button } from '../../ui/components/Button';
import { EmptyState } from '../../ui/components/Basics';
import { ItemArt } from '../../ui/components/ItemArt';
import { DetailSheet } from '../../features/sheets/DetailSheet';
import { useDemoStore } from '../../features/demoStore';
import { categories, type DemoItem, type ItemCategory } from '../../data/demo';
import { colors, type } from '../../ui/tokens';

const filters: ('全部' | ItemCategory)[] = ['全部', ...categories];

// 衣橱（原型 closet()）：筛选胶囊 + 两列单品网格 + 空衣橱态。
export default function WardrobeScreen() {
  const router = useRouter();
  const { items, newUser } = useDemoStore();
  const [filter, setFilter] = useState<(typeof filters)[number]>('全部');
  const [detailItem, setDetailItem] = useState<DemoItem | null>(null);

  // 新用户分支（原型 first-run）：仅显示用户自己录入的单品（M1 以“颜色尚未确认”标记用户录入件）
  const list = newUser ? items.filter((i) => i.color === '尚未确认') : items;
  const visible = list.filter((i) => filter === '全部' || i.cat === filter);

  return (
    <Page>
      <PageTop
        title="我的衣橱"
        sub={`${list.length} 件已录入 · 慢慢收集，常常喜欢`}
        right={
          <Button
            variant="round"
            icon="plus"
            accessibilityLabel="添加衣服"
            onPress={() => router.push('/add')}
          />
        }
      />

      <View style={styles.chips}>
        {filters.map((c) => (
          <Button key={c} variant="chip" label={c} active={filter === c} onPress={() => setFilter(c)} />
        ))}
      </View>

      {visible.length > 0 ? (
        <>
          <View style={styles.grid}>
            {visible.map((item) => (
              <Pressable
                key={item.id}
                accessibilityRole="button"
                accessibilityLabel={item.name}
                onPress={() => setDetailItem(item)}
                style={styles.card}>
                <ItemArt x={item.x} y={item.y} radius={15} />
                <Text style={styles.cardName}>{item.name}</Text>
                <Text style={styles.cardMeta}>{item.cat} / 演示单品</Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.subtleInfo}>照片先存下来，尺寸和细节用到时再补。</Text>
        </>
      ) : (
        <EmptyState
          icon="closet"
          title="一件，就是好的开始。"
          action={{ label: '添加第一件', onPress: () => router.push('/add') }}>
          {'先添加今天想穿的衣服，\n不需要一次整理整个衣橱。'}
        </EmptyState>
      )}

      <DetailSheet item={detailItem} onClose={() => setDetailItem(null)} onUse={() => router.push('/outfit')} />
    </Page>
  );
}

const styles = StyleSheet.create({
  chips: {
    flexDirection: 'row',
    gap: 8,
    marginVertical: 17,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 19,
    columnGap: 13,
  },
  card: {
    width: '47.5%',
    alignItems: 'flex-start',
  },
  cardName: {
    color: colors.ink,
    fontSize: 12,
    fontWeight: '500',
    lineHeight: 18,
    marginTop: 9,
  },
  cardMeta: {
    color: colors.muted,
    fontSize: 10,
    lineHeight: 14,
    marginTop: 3,
  },
  subtleInfo: {
    ...type.footnote,
    lineHeight: 20,
    color: colors.subtleInfo,
    marginTop: 15,
    marginBottom: 12,
  },
});

import { useCallback, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { Page } from '../../ui/Screen';
import { PageTop } from '../../ui/PageTop';
import { Button } from '../../ui/components/Button';
import { EmptyState, Tag } from '../../ui/components/Basics';
import { FeedbackSheet } from '../../features/sheets/FeedbackSheet';
import { loadOutfitFrom } from '../../features/outfitSession';
import { listPlans, type SavedPlan } from '../../data/repositories/planRepository';
import { getItem } from '../../data/repositories/itemRepository';
import { getMainPhotoPaths, photoUri } from '../../data/repositories/photoRepository';
import { slotForCategory } from '../../features/outfitSession';
import { colors, radius, type } from '../../ui/tokens';

const filters = ['全部', '穿过', '穿过且满意'] as const;

// 搭配（M3 真实版）：保存的方案列表 + 穿着筛选 + 感受记录入口。
// 收藏 / 穿过 / 满意分别记录，未反馈不视为满意（AGENTS §4 规则 11）。
export default function OutfitsScreen() {
  const router = useRouter();
  const [plans, setPlans] = useState<SavedPlan[]>([]);
  const [filter, setFilter] = useState<(typeof filters)[number]>('全部');
  const [feedbackId, setFeedbackId] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      void (async () => setPlans(await listPlans()))();
    }, []),
  );

  const list = plans.filter((p) =>
    filter === '全部'
      ? true
      : filter === '穿过且满意'
        ? p.wornState === 'yes'
        : filter === '穿过'
          ? p.wornState !== 'unworn'
          : true,
  );

  async function reuse(plan: SavedPlan) {
    // 槽位按单品品类推导（与 startOutfitFrom 的规则一致）
    const slots: Partial<Record<'top' | 'dress' | 'bottom' | 'shoes', string>> = {};
    for (const item of plan.items) {
      const wardrobeItem = await getItem(item.itemId);
      if (!wardrobeItem?.category) continue;
      const slot = slotForCategory(wardrobeItem.category);
      if (slot && !slots[slot]) slots[slot] = item.itemId;
    }
    loadOutfitFrom({
      planId: plan.id,
      name: plan.name,
      basisId: plan.basisItemId,
      slots,
      wear: plan.wear.style,
      itemIds: plan.items.map((i) => i.itemId),
    });
    router.push('/outfit');
  }

  return (
    <Page>
      <PageTop title="我的搭配" sub="把喜欢的，留给下一次。" />

      <View style={styles.chips}>
        {filters.map((c) => (
          <Button key={c} variant="chip" label={c} active={filter === c} onPress={() => setFilter(c)} />
        ))}
      </View>

      {list.length > 0 ? (
        list.map((plan) => (
          <View key={plan.id} style={styles.card}>
            <View style={styles.thumbRow}>
              {plan.items.slice(0, 4).map((item) => (
                <PlanThumb key={item.itemId} itemId={item.itemId} />
              ))}
            </View>
            <View style={styles.cardContent}>
              <Tag
                label={
                  plan.wornState === 'yes'
                    ? '穿过且满意'
                    : plan.wornState === 'no'
                      ? '已穿过 · 未确认满意'
                      : plan.wornState === 'unknown'
                        ? '已穿过 · 未确认满意'
                        : '已收藏 · 尚未穿过'
                }
              />
              <Text style={styles.cardName} numberOfLines={1}>
                {plan.name ?? '我的搭配'}
              </Text>
              <Text style={styles.cardMeta}>
                {plan.scene.scene || '未设场景'} · {plan.wear.style} · {plan.items.length} 件单品
              </Text>
              <View style={styles.cardActions}>
                <Button
                  variant="secondary"
                  label="再穿这套"
                  onPress={() => void reuse(plan)}
                  style={styles.cardButton}
                />
                <Button
                  variant="secondary"
                  label={plan.wornState === 'unworn' ? '今天穿了' : '补充感受'}
                  onPress={() => setFeedbackId(plan.id)}
                  style={styles.cardButton}
                />
              </View>
            </View>
          </View>
        ))
      ) : (
        <EmptyState
          icon="bookmark"
          title={filter === '全部' ? '喜欢的搭配，值得留下。' : '还没有这样的穿着记录'}
          action={
            filter === '全部'
              ? { label: '去搭一套', onPress: () => router.push('/choose') }
              : undefined
          }>
          {filter === '全部'
            ? '搭配完成后保存到这里，\n下次不用重新开始。'
            : '收藏不等于穿过。\n真实穿着后，再记录你的感受。'}
        </EmptyState>
      )}

      <FeedbackSheet planId={feedbackId} onClose={() => setFeedbackId(null)} />
    </Page>
  );
}

function PlanThumb({ itemId }: { itemId: string }) {
  const [uri, setUri] = useState<string | null>(null);
  useFocusEffect(
    useCallback(() => {
      getMainPhotoPaths(itemId).then((paths) => setUri(paths ? photoUri(paths.thumbPath) : null));
    }, [itemId]),
  );
  return uri ? (
    <Image source={{ uri }} style={styles.thumb} resizeMode="cover" />
  ) : (
    <View style={[styles.thumb, styles.thumbPlaceholder]} />
  );
}

const styles = StyleSheet.create({
  chips: {
    flexDirection: 'row',
    gap: 8,
    marginVertical: 17,
  },
  card: {
    borderRadius: radius.savedCard,
    overflow: 'hidden',
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.line,
    marginVertical: 15,
  },
  thumbRow: {
    flexDirection: 'row',
    gap: 2,
    backgroundColor: colors.boardBg,
  },
  thumb: {
    flex: 1,
    aspectRatio: 1,
    backgroundColor: colors.artBg,
  },
  thumbPlaceholder: {
    backgroundColor: colors.line,
  },
  cardContent: {
    padding: 15,
  },
  cardName: {
    ...type.sectionHead,
    color: colors.ink,
    marginTop: 10,
  },
  cardMeta: {
    ...type.footnote,
    color: colors.muted,
    marginVertical: 7,
  },
  cardActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 13,
  },
  cardButton: {
    flex: 1,
  },
});

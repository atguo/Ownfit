import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Page } from '../../ui/Screen';
import { PageTop } from '../../ui/PageTop';
import { Button } from '../../ui/components/Button';
import { EmptyState, Tag } from '../../ui/components/Basics';
import { OutfitBoard } from '../../ui/components/OutfitBoard';
import { FeedbackSheet } from '../../features/sheets/FeedbackSheet';
import { reuseOutfit, useDemoStore } from '../../features/demoStore';
import { colors, radius, type } from '../../ui/tokens';

const filters = ['全部', '穿过', '穿过且满意'] as const;

// 搭配（原型 saved()）：筛选 + 收藏卡列表 + 空态。
// 收藏 / 穿过 / 满意分别记录，未反馈不视为满意（AGENTS 第 4 节规则 11）。
export default function OutfitsScreen() {
  const router = useRouter();
  const { saved } = useDemoStore();
  const [filter, setFilter] = useState<(typeof filters)[number]>('全部');
  const [feedbackId, setFeedbackId] = useState<string | null>(null);

  const list = saved.filter((s) =>
    filter === '全部'
      ? true
      : filter === '穿过且满意'
        ? s.worn && s.satisfied
        : s.worn,
  );

  return (
    <Page>
      <PageTop title="我的搭配" sub="把喜欢的，留给下一次。" />

      <View style={styles.chips}>
        {filters.map((c) => (
          <Button key={c} variant="chip" label={c} active={filter === c} onPress={() => setFilter(c)} />
        ))}
      </View>

      {list.length > 0 ? (
        list.map((s) => (
          <View key={s.id} style={styles.card}>
            <OutfitBoard topId={s.top} small />
            <View style={styles.cardContent}>
              <Tag
                label={
                  s.worn ? (s.satisfied ? '穿过且满意' : '已穿过 · 未确认满意') : '已收藏 · 尚未穿过'
                }
              />
              <Text style={styles.cardName}>{s.name}</Text>
              <Text style={styles.cardMeta}>
                {s.scene} · {s.wear} · {s.ids.length} 件单品
              </Text>
              <View style={styles.cardActions}>
                <Button
                  variant="secondary"
                  label="再穿这套"
                  onPress={() => {
                    if (reuseOutfit(s.id)) {
                      router.push('/outfit');
                    }
                  }}
                  style={styles.cardButton}
                />
                <Button
                  variant="secondary"
                  label={s.worn ? '补充感受' : '今天穿了'}
                  onPress={() => setFeedbackId(s.id)}
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

      <FeedbackSheet outfitId={feedbackId} onClose={() => setFeedbackId(null)} />
    </Page>
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

import { useCallback, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { Page } from '../../ui/Screen';
import { PageTop } from '../../ui/PageTop';
import { Button } from '../../ui/components/Button';
import { EmptyState } from '../../ui/components/Basics';
import { WardrobeItemSheet, type WardrobeItemDetail } from '../../features/sheets/WardrobeItemSheet';
import {
  getItem,
  getMainThumb,
  listItemIdsByStatus,
  type ItemStatus,
  type WardrobeItem,
} from '../../data/repositories/itemRepository';
import { getMainPhotoPaths, photoUri } from '../../data/repositories/photoRepository';
import { categories, type ItemCategory } from '../../data/demo';
import { colors, type } from '../../ui/tokens';

const filters: ('全部' | ItemCategory)[] = ['全部', ...categories];

interface ItemView {
  item: WardrobeItem;
  thumbUri: string | null;
  originalUri: string | null;
}

// 衣橱（M2 真实版）：SQLite 数据源 + 筛选 + 草稿区 + 已归档入口。
// 演示数据不出现在此页（AGENTS §4 规则 5：真实衣橱与演示隔离）。
export default function WardrobeScreen() {
  const router = useRouter();
  const [drafts, setDrafts] = useState<ItemView[]>([]);
  const [active, setActive] = useState<ItemView[]>([]);
  const [archived, setArchived] = useState<ItemView[]>([]);
  const [filter, setFilter] = useState<'全部' | ItemCategory | '已归档'>('全部');
  const [detail, setDetail] = useState<WardrobeItemDetail | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const loadViews = async (status: ItemStatus): Promise<ItemView[]> => {
      const ids = await listItemIdsByStatus(status);
      const views: ItemView[] = [];
      for (const id of ids) {
        const [item, paths] = await Promise.all([getItem(id), getMainPhotoPaths(id)]);
        if (item) {
          views.push({
            item,
            thumbUri: paths ? photoUri(paths.thumbPath) : null,
            originalUri: paths ? photoUri(paths.originalPath) : null,
          });
        }
      }
      return views;
    };
    setDrafts(await loadViews('draft'));
    setActive(await loadViews('active'));
    setArchived(await loadViews('archived'));
    setLoaded(true);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const showArchived = filter === '已归档';
  const list = showArchived
    ? archived
    : active.filter((v) => filter === '全部' || v.item.category === filter);
  const hasArchived = archived.length > 0;

  function renderCard(view: ItemView) {
    const isDraft = view.item.status === 'draft';
    const meta = isDraft
      ? '草稿 · 待确认品类'
      : `${view.item.category ?? '未分类'} / ${view.item.status === 'archived' ? '已归档' : '已入库'}`;
    return (
      <Pressable
        key={view.item.id}
        accessibilityRole="button"
        accessibilityLabel={view.item.name ?? view.item.category ?? '单品'}
        onPress={() => setDetail(view)}
        style={styles.card}>
        {view.thumbUri ? (
          <Image source={{ uri: view.thumbUri }} style={styles.cardArt} resizeMode="cover" />
        ) : (
          <View style={[styles.cardArt, styles.cardArtPlaceholder]} />
        )}
        <Text style={styles.cardName} numberOfLines={1}>
          {view.item.name ?? view.item.category ?? '未分类草稿'}
        </Text>
        <Text style={styles.cardMeta}>{meta}</Text>
      </Pressable>
    );
  }

  return (
    <Page>
      <PageTop
        title="我的衣橱"
        sub={`${active.length} 件已录入 · 慢慢收集，常常喜欢`}
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
        {hasArchived ? (
          <Button
            variant="chip"
            label={`已归档 ${archived.length}`}
            active={showArchived}
            onPress={() => setFilter('已归档')}
          />
        ) : null}
      </View>

      {drafts.length > 0 && !showArchived ? (
        <>
          <Text style={styles.draftHead}>草稿 · 待确认品类（{drafts.length}）</Text>
          <View style={styles.grid}>{drafts.map(renderCard)}</View>
        </>
      ) : null}

      {list.length > 0 ? (
        <View style={styles.mainSection}>
          <View style={styles.grid}>{list.map(renderCard)}</View>
          {!showArchived ? (
            <Text style={styles.subtleInfo}>照片先存下来，尺寸和细节用到时再补。</Text>
          ) : null}
        </View>
      ) : drafts.length === 0 ? (
        <EmptyState
          icon="closet"
          title={showArchived ? '没有已归档的单品' : '一件，就是好的开始。'}
          action={
            showArchived ? undefined : { label: '添加第一件', onPress: () => router.push('/add') }
          }>
          {showArchived
            ? '归档的单品会出现在这里。'
            : '先添加今天想穿的衣服，\n不需要一次整理整个衣橱。'}
        </EmptyState>
      ) : null}

      <WardrobeItemSheet
        detail={detail}
        onClose={() => setDetail(null)}
        onChanged={() => {
          setDetail(null);
          void load();
        }}
      />
    </Page>
  );
}

const styles = StyleSheet.create({
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginVertical: 17,
  },
  draftHead: {
    ...type.heading,
    color: colors.ink,
    marginTop: 6,
    marginBottom: 12,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 19,
    columnGap: 13,
  },
  mainSection: {
    marginTop: 17,
  },
  card: {
    width: '47.5%',
    alignItems: 'flex-start',
  },
  cardArt: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: 15,
    backgroundColor: colors.artBg,
  },
  cardArtPlaceholder: {
    backgroundColor: colors.line,
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


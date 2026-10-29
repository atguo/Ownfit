import { useCallback, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { Page } from '../ui/Screen';
import { BackTitle } from '../ui/PageTop';
import { Button } from '../ui/components/Button';
import { Notice, Tag } from '../ui/components/Basics';
import { startOutfitFrom } from '../features/outfitSession';
import {
  getItem,
  getMainThumb,
  listItemIdsByStatus,
  type WardrobeItem,
} from '../data/repositories/itemRepository';
import { photoUri } from '../data/repositories/photoRepository';
import { colors, type } from '../ui/tokens';

// 选择基础单品（M3 真实版）：从已入库单品中选择本轮搭配的起点。
// 搭配会话（outfitSession）将自动填充互补槽位；缺失品类在搭配页按缺口表达。
export default function ChooseScreen() {
  const router = useRouter();
  const [items, setItems] = useState<WardrobeItem[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      (async () => {
        const ids = await listItemIdsByStatus('active');
        const views: WardrobeItem[] = [];
        const thumbMap: Record<string, string> = {};
        for (const id of ids) {
          const item = await getItem(id);
          if (!item) continue;
          views.push(item);
          const thumb = await getMainThumb(id);
          if (thumb) thumbMap[id] = photoUri(thumb);
        }
        if (active) {
          setItems(views);
          setThumbs(thumbMap);
          setSelected((prev) => (prev && views.some((v) => v.id === prev) ? prev : views[0]?.id ?? null));
          setLoaded(true);
        }
      })();
      return () => {
        active = false;
      };
    }, []),
  );

  async function start() {
    if (selected && (await startOutfitFrom(selected))) router.push('/outfit');
  }

  return (
    <Page
      footer={
        <>
          <Button
            variant="primary"
            label={items.length ? '搭配这件衣服' : '添加第一件'}
            onPress={() => {
              if (items.length && selected) void start();
              else router.push('/add');
            }}
          />
          <Text style={styles.underNote}>选中的单品会保持锁定</Text>
        </>
      }>
      <BackTitle title="从哪一件开始？" onBack={() => router.back()} />
      <Tag icon="closet" label="来自你的真实衣橱" />
      <View style={styles.tagGap} />
      <Text style={[type.titleXL, styles.title]}>今天，想穿这件。</Text>
      <Text style={styles.subtitle}>选中一件喜欢的，其他的交给搭配。</Text>

      {items.length > 0 ? (
        <View style={styles.grid}>
          {items.map((item) => {
            const isSelected = selected === item.id;
            return (
              <Pressable
                key={item.id}
                accessibilityRole="button"
                accessibilityState={{ selected: isSelected }}
                accessibilityLabel={item.name ?? item.category ?? ''}
                onPress={() => setSelected(item.id)}
                style={[styles.cell, isSelected && styles.cellSelected]}>
                {thumbs[item.id] ? (
                  <Image source={{ uri: thumbs[item.id] ?? undefined }} style={styles.cellArt} resizeMode="cover" />
                ) : (
                  <View style={[styles.cellArt, styles.cellPlaceholder]} />
                )}
                <Text style={styles.cellName}>{item.name ?? item.category}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : loaded ? (
        <Notice>还没有录入衣服，先添加一件就好。</Notice>
      ) : null}
    </Page>
  );
}

const styles = StyleSheet.create({
  tagGap: {
    height: 13,
  },
  title: {
    color: colors.ink,
  },
  subtitle: {
    fontSize: 12,
    lineHeight: 19,
    color: colors.muted,
    marginTop: 6,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 12,
    marginVertical: 18,
  },
  cell: {
    width: '47.5%',
    borderWidth: 2,
    borderColor: 'transparent',
    borderRadius: 15,
    padding: 5,
  },
  cellSelected: {
    borderColor: colors.green,
  },
  cellArt: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: 13,
    backgroundColor: colors.artBg,
  },
  cellPlaceholder: {
    backgroundColor: colors.line,
  },
  cellName: {
    color: colors.ink,
    fontSize: 12,
    fontWeight: '500',
    lineHeight: 18,
    marginTop: 9,
    marginBottom: 5,
  },
  underNote: {
    textAlign: 'center',
    fontSize: 10,
    lineHeight: 14,
    color: colors.muted,
    marginTop: 9,
  },
});

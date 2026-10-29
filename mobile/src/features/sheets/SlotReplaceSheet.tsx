// 槽位替换（M3 真实版）：只列同槽位真实候选；只替换未锁定项（锁定件调用方先拦截）。
// 无候选时按功能文档措辞表达缺口："已录入衣橱中暂未找到…"+ 添加入口。

import { useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { Sheet } from '../../ui/components/Sheet';
import { Notice } from '../../ui/components/Basics';
import { Button } from '../../ui/components/Button';
import { useToast } from '../../ui/components/Toast';
import { getItem, listItemIdsByStatus, type WardrobeItem } from '../../data/repositories/itemRepository';
import { getMainPhotoPaths, photoUri } from '../../data/repositories/photoRepository';
import { replaceSlot, slotForCategory, slotGapMessage, type OutfitSlot } from '../outfitSession';
import { colors, radius, type } from '../../ui/tokens';

export function SlotReplaceSheet({
  slot,
  currentItemId,
  onClose,
  onGoAdd,
}: {
  slot: OutfitSlot | null;
  currentItemId: string | null;
  onClose: () => void;
  onGoAdd: () => void;
}) {
  const toast = useToast();
  const [candidates, setCandidates] = useState<WardrobeItem[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!slot) return;
    let active = true;
    (async () => {
      const ids = await listItemIdsByStatus('active');
      const views: WardrobeItem[] = [];
      const thumbMap: Record<string, string> = {};
      for (const candidateId of ids) {
        const candidate = await getItem(candidateId);
        if (!candidate?.category) continue;
        if (slotForCategory(candidate.category) !== slot) continue;
        if (candidateId === currentItemId) continue;
        const paths = await getMainPhotoPaths(candidateId);
        views.push(candidate);
        if (paths) thumbMap[candidateId] = photoUri(paths.thumbPath);
      }
      if (active) {
        setCandidates(views);
        setThumbs(thumbMap);
        setLoaded(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [slot, currentItemId]);

  const current = currentItemId ? getItem(currentItemId) : null;

  function applyReplace(newItemId: string) {
    if (!slot) return;
    const result = replaceSlot(slot, newItemId);
    if (result === 'locked') {
      toast('这件单品已锁定');
      return;
    }
    onClose();
    toast('已替换一件，其他锁定单品保持不变');
  }

  return (
    <Sheet visible={slot != null} title="只换这一件。" onClose={onClose}>
      <Text style={styles.description}>其他锁定单品保持不变。</Text>
      {candidates.length > 0 ? (
        <View style={styles.grid}>
          {candidates.map((candidate) => (
            <Pressable
              key={candidate.id}
              accessibilityRole="button"
              accessibilityLabel={`替换为${candidate.name ?? candidate.category}`}
              onPress={() => applyReplace(candidate.id)}
              style={({ pressed }) => [styles.cell, pressed && styles.cellPressed]}>
              {thumbs[candidate.id] ? (
                <Image source={{ uri: thumbs[candidate.id] }} style={styles.cellArt} resizeMode="cover" />
              ) : (
                <View style={[styles.cellArt, styles.cellPlaceholder]} />
              )}
              <Text style={styles.cellName}>{candidate.name ?? candidate.category}</Text>
            </Pressable>
          ))}
        </View>
      ) : loaded ? (
        slot && <Notice>{slotGapMessage(slot)}</Notice>
      ) : null}
      {candidates.length === 0 ? (
        <Button variant="primary" label="添加我已有的" onPress={onGoAdd} />
      ) : null}
      <Button variant="text" label="保留原来的搭配" onPress={onClose} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  description: {
    ...type.caption,
    color: colors.muted,
    lineHeight: 23,
    marginBottom: 15,
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
  cellPressed: {
    borderColor: colors.choiceSelectedBorder,
    backgroundColor: colors.choiceSelectedBg,
  },
  cellArt: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: radius.buttonLg,
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
});

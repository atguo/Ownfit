import { useCallback, useEffect, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Page } from '../ui/Screen';
import { BackTitle } from '../ui/PageTop';
import { Button } from '../ui/components/Button';
import { Tag } from '../ui/components/Basics';
import { Icon } from '../ui/Icon';
import { RealOutfitBoard } from '../ui/components/RealOutfitBoard';
import { Sheet } from '../ui/components/Sheet';
import { WearSheet } from '../features/sheets/WearSheet';
import { SlotReplaceSheet } from '../features/sheets/SlotReplaceSheet';
import {
  buildContractPlan,
  getOutfitSession,
  missingSlots,
  outfitHistoryLength,
  outfitUndo,
  replaceSlot,
  setWear,
  toggleLock,
  useOutfitSession,
  slotGapMessage,
  slotLabels,
  type OutfitSlot,
} from '../features/outfitSession';
import { getContextSnapshot } from '../features/demoStore';
import { findDuplicate, saveContractPlan } from '../data/repositories/planRepository';
import { getItem } from '../data/repositories/itemRepository';
import { getMainPhotoPaths } from '../data/repositories/photoRepository';
import { photoUri } from '../data/repositories/photoRepository';
import { useToast } from '../ui/components/Toast';
import { colors, type } from '../ui/tokens';

// M3 搭配（真实会话）：锁定/替换/穿法/撤销 → 保存为方案（契约校验后入库）。
// 缺失槽位按缺口表达（不虚构完整组合）；上身预览未接入（诚实提示，不显示虚构图）。

interface SlotView {
  slot: OutfitSlot;
  itemId: string;
  name: string;
  category: string;
  thumbUri: string | null;
}

export default function OutfitScreen() {
  const router = useRouter();
  const toast = useToast();
  const session = useOutfitSession();
  const [slotViews, setSlotViews] = useState<Record<string, SlotView>>({});
  const [wearOpen, setWearOpen] = useState(false);
  const [replaceSlotOpen, setReplaceSlotOpen] = useState<OutfitSlot | null>(null);
  const [previewNotice, setPreviewNotice] = useState(false);

  const presentSlots = (['dress', 'top', 'bottom', 'shoes'] as OutfitSlot[]).filter(
    (slot) => session.slots[slot],
  );
  const missing = missingSlots(session.slots);

  // 槽位单品数据解析（异步 DB）
  const loadSlotViews = useCallback(async () => {
    const result: Record<string, SlotView> = {};
    for (const [slot, itemId] of Object.entries(session.slots)) {
      if (!itemId) continue;
      const item = await getItem(itemId);
      if (!item) continue;
      const paths = await getMainPhotoPaths(itemId);
      result[slot] = {
        slot: slot as OutfitSlot,
        itemId,
        name: item.name ?? item.category ?? '未命名',
        category: item.category ?? '未分类',
        thumbUri: paths ? photoUri(paths.thumbPath) : null,
      };
    }
    setSlotViews(result);
  }, [session.slots]);

  useEffect(() => {
    void loadSlotViews();
  }, [loadSlotViews]);

  function save() {
    const scene = getContextSnapshot();
    const plan = buildContractPlan(`plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, {
      city: scene.city,
      day: scene.day,
      scene: scene.scene,
    });
    const pieces = plan.items.map((i) => i.itemId);
    void (async () => {
      const duplicate = await findDuplicate(pieces, plan.wear.style);
      if (duplicate) {
        toast('这套已经收藏，可以在“搭配”里找到');
        return;
      }
      try {
        await saveContractPlan(plan, null);
        toast('已收藏到“我的搭配”，尚未标记穿过');
      } catch (error) {
        toast(error instanceof Error ? error.message : '保存失败，请重试');
      }
    })();
  }

  const parentDiff = parentDiffText(session.parentItemIds, session.slots);

  return (
    <Page>
      <BackTitle
        title="为你搭配"
        onBack={() => router.back()}
        right={
          outfitHistoryLength() > 0 ? (
            <Button
              variant="text"
              icon="undo"
              label="撤销"
              onPress={() => {
                if (outfitUndo()) toast('已恢复上一版搭配');
              }}
            />
          ) : null
        }
      />
      <Tag icon="closet" label="来自真实衣橱" />
      {session.parentLabel ? (
        <Text style={styles.parentLine}>复用自「{session.parentLabel}」{parentDiff}</Text>
      ) : null}

      <RealOutfitBoard
        slots={{
          top: slotViews['top']?.thumbUri ?? null,
          dress: slotViews['dress']?.thumbUri ?? null,
          bottom: slotViews['bottom']?.thumbUri ?? null,
          shoes: slotViews['shoes']?.thumbUri ?? null,
        }}
        lockLabel={session.locks.length ? '含锁定单品' : undefined}
        caption="已录入衣橱的组合"
      />

      {presentSlots.map((slot) => {
        const view = slotViews[slot];
        const itemId = session.slots[slot] as string;
        const locked = session.locks.includes(itemId);
        return (
          <View key={slot} style={styles.pieceRow}>
            {view?.thumbUri ? (
              <Image source={{ uri: view.thumbUri }} style={styles.pieceArt} resizeMode="cover" />
            ) : (
              <View style={[styles.pieceArt, styles.piecePlaceholder]} />
            )}
            <View style={styles.pieceText}>
              <Text style={styles.pieceName} numberOfLines={1}>
                {view?.name ?? '加载中…'}
              </Text>
              <Text style={styles.pieceNote}>
                {locked ? '已锁定，替换时保留' : `可换成其他${slotLabels[slot]}`}
              </Text>
            </View>
            <Button
              variant="small"
              icon={locked ? 'lock' : 'unlock'}
              accessibilityLabel={`${locked ? '解锁' : '锁定'}${view?.name ?? ''}`}
              locked={locked}
              onPress={() => toggleLock(itemId)}
            />
            <Button
              variant="small"
              label="换一件"
              disabled={locked}
              onPress={() => setReplaceSlotOpen(slot)}
            />
          </View>
        );
      })}

      {missing.map((slot) => (
        <View key={slot} style={[styles.pieceRow, styles.missingRow]}>
          <View style={[styles.pieceArt, styles.missingPlaceholder]} />
          <View style={styles.pieceText}>
            <Text style={styles.pieceName}>{slotLabels[slot]}</Text>
            <Text style={styles.pieceNote}>{slotGapMessage(slot)}</Text>
          </View>
          <Button variant="small" label="添加" onPress={() => router.push('/add')} />
        </View>
      ))}

      <View style={styles.wearing}>
        <Text style={styles.wearingText}>穿法 · {session.wear}</Text>
        <Button variant="text" label="调整穿法" onPress={() => setWearOpen(true)} />
      </View>

      <View style={styles.actions}>
        <Button
          variant="primary"
          icon="bookmark"
          label="保存这套搭配"
          onPress={save}
        />
        <Button
          variant="secondary"
          icon="spark"
          accessibilityLabel="上身预览"
          onPress={() => setPreviewNotice(true)}
        />
      </View>
      <Text style={styles.underNote}>上身预览将随 AI 能力接入开放，当前版本不生成预览图</Text>

      <WearSheet visible={wearOpen} onClose={() => setWearOpen(false)} />
      <SlotReplaceSheet
        slot={replaceSlotOpen}
        currentItemId={replaceSlotOpen ? session.slots[replaceSlotOpen] ?? null : null}
        onClose={() => setReplaceSlotOpen(null)}
        onGoAdd={() => {
          setReplaceSlotOpen(null);
          router.push('/add');
        }}
      />

      {previewNotice ? (
        <Sheet visible title="上身预览未接入" onClose={() => setPreviewNotice(false)}>
          <Text style={styles.description}>
            {'上身预览将随 AI 能力接入开放。当前版本不生成预览图，\n避免以虚构效果代替你的真实穿着。搭配已保留，可先收藏。'}
          </Text>
          <Button variant="primary" label="知道了" onPress={() => setPreviewNotice(false)} />
        </Sheet>
      ) : null}
    </Page>
  );
}

function parentDiffText(parentItemIds: string[], slots: Partial<Record<OutfitSlot, string>>): string {
  if (!parentItemIds.length) return '';
  const changed = (Object.entries(slots) as [OutfitSlot, string][])
    .filter(([, id]) => id && !parentItemIds.includes(id))
    .map(([slot]) => slotLabels[slot]);
  return changed.length ? `较上一版：调整了 ${changed.join('、')}` : '沿用上一版组合';
}

const styles = StyleSheet.create({
  description: {
    ...type.caption,
    color: colors.muted,
    lineHeight: 23,
    marginBottom: 15,
  },
  parentLine: {
    fontSize: 11,
    lineHeight: 16,
    color: colors.muted,
    marginTop: 8,
  },
  pieceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  missingRow: {
    opacity: 0.85,
  },
  pieceArt: {
    width: 49,
    height: 49,
    borderRadius: 9,
    backgroundColor: colors.artBg,
    flexShrink: 0,
  },
  piecePlaceholder: {
    backgroundColor: colors.line,
  },
  pieceText: {
    flex: 1,
    minWidth: 0,
  },
  pieceName: {
    color: colors.ink,
    fontSize: 12,
    fontWeight: '500',
    lineHeight: 18,
  },
  pieceNote: {
    color: colors.muted,
    fontSize: 10,
    lineHeight: 14,
  },
  wearing: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
  },
  wearingText: {
    fontSize: 11,
    lineHeight: 16,
    color: colors.muted,
  },
  missingPlaceholder: {
    backgroundColor: colors.line,
  },
  actions: {
    flexDirection: 'row',
    gap: 9,
    marginTop: 17,
  },
  underNote: {
    textAlign: 'center',
    fontSize: 10,
    lineHeight: 14,
    color: colors.muted,
    marginTop: 9,
  },
});

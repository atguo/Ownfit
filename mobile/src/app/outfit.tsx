import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Page } from '../ui/Screen';
import { BackTitle } from '../ui/PageTop';
import { Button } from '../ui/components/Button';
import { Tag } from '../ui/components/Basics';
import { Icon } from '../ui/Icon';
import { OutfitBoard } from '../ui/components/OutfitBoard';
import { ItemArt } from '../ui/components/ItemArt';
import { WearSheet } from '../features/sheets/WearSheet';
import { ReplaceSheet } from '../features/sheets/ReplaceSheet';
import {
  PreviewSheet,
  ReferencePrepareSheet,
  type PreviewSheetState,
} from '../features/sheets/PreviewSheets';
import {
  getPieceIds,
  getItem,
  isCurrentSaved,
  markPreviewReady,
  outfitHistoryLength,
  outfitUndo,
  saveOutfit,
  setReference,
  toggleLock,
  useDemoStore,
} from '../features/demoStore';
import { useToast } from '../ui/components/Toast';
import { colors, type } from '../ui/tokens';

// 搭配与局部调整（原型 outfit()）：搭配板、清单（锁定/替换）、穿法、撤销、收藏、预览入口。
export default function OutfitScreen() {
  const router = useRouter();
  const toast = useToast();
  const store = useDemoStore();
  const [wearOpen, setWearOpen] = useState(false);
  const [replaceId, setReplaceId] = useState<string | null>(null);
  const [previewSheet, setPreviewSheet] = useState<PreviewSheetState | 'reference'>(null);

  const selectItem = getItem(store.select);
  const savedAlready = isCurrentSaved();
  const pieces = getPieceIds();

  const outfitTitle =
    store.top === 'sage'
      ? '多一点松弛感。'
      : store.top === 'blue'
        ? '清爽，也很利落。'
        : '舒服得刚刚好。';
  const reason =
    store.top === 'sage'
      ? '柔和的绿色让灰色更轻盈，敞开穿也更自在。\n晚间降温时，可另选一件外层。'
      : '浅色上衣让整体更轻盈，阔腿线条保留舒服的余地。\n晚间降温时，可另选一件外层。';

  // 原型 startPreview：未准备参考先引导，否则 900ms 模拟等待后进入预览
  function startPreview() {
    if (!store.reference) {
      setPreviewSheet('reference');
      return;
    }
    setPreviewSheet('loading');
  }

  function save() {
    const result = saveOutfit();
    toast(
      result === 'duplicate'
        ? '这套已经收藏，可以在“搭配”里找到'
        : '已收藏到“我的搭配”，尚未标记穿过',
    );
  }

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
      <Tag icon="closet" label="来自你的衣橱" />
      <View style={styles.outfitTitle}>
        <Text style={[type.titleLg, styles.outfitTitleText]}>{outfitTitle}</Text>
        <Text style={styles.subtitle}>
          {store.context.day} · {store.context.scene} · {store.context.temp}
        </Text>
      </View>

      <OutfitBoard topId={store.top} lockLabel={selectItem?.name} />

      <View style={styles.reason}>
        <Icon name="leaf" size={17} color={colors.reasonIcon} />
        <Text style={styles.reasonText}>{reason}</Text>
      </View>

      {pieces.map((id) => {
        const item = getItem(id);
        if (!item) return null;
        const locked = store.locks.includes(id);
        return (
          <View key={id} style={styles.pieceRow}>
            <ItemArt x={item.x} y={item.y} radius={9} style={styles.pieceArt} />
            <View style={styles.pieceText}>
              <Text style={styles.pieceName}>{item.name}</Text>
              <Text style={styles.pieceNote}>
                {locked ? '已锁定，替换时保留' : '可换成其他喜欢的单品'}
              </Text>
            </View>
            <Button
              variant="small"
              icon={locked ? 'lock' : 'unlock'}
              accessibilityLabel={`${locked ? '解锁' : '锁定'}${item.name}`}
              locked={locked}
              onPress={() => toggleLock(id)}
            />
            <Button
              variant="small"
              label="换一件"
              onPress={() => {
                if (locked) {
                  toast('这件已锁定。解锁后才能替换。');
                  return;
                }
                setReplaceId(id);
              }}
            />
          </View>
        );
      })}

      <View style={styles.wearing}>
        <Text style={styles.wearingText}>穿法 · {store.wear}</Text>
        <Button variant="text" label="调整穿法" onPress={() => setWearOpen(true)} />
      </View>

      <View style={styles.actions}>
        <Button variant="primary" icon="spark" label="看看上身效果" onPress={startPreview} />
        <Button
          variant="secondary"
          icon="bookmark"
          saved={savedAlready}
          accessibilityLabel="收藏这套搭配"
          onPress={save}
        />
      </View>
      <Text style={styles.underNote}>可以先保存搭配，预览稍后再看</Text>

      <WearSheet visible={wearOpen} onClose={() => setWearOpen(false)} />
      <ReplaceSheet
        targetId={replaceId}
        onClose={() => setReplaceId(null)}
        onGoAdd={() => {
          setReplaceId(null);
          router.push('/add');
        }}
      />

      {/* 预览流程弹层：参考引导 / 900ms 模拟等待 / 失败体验 */}
      <ReferencePrepareSheet
        visible={previewSheet === 'reference'}
        onClose={() => setPreviewSheet(null)}
        onUseDemo={() => {
          setReference(true);
          setPreviewSheet('loading');
        }}
      />
      <PreviewSheet
        state={previewSheet === 'reference' ? null : previewSheet}
        onClose={() => setPreviewSheet(null)}
        onReady={() => {
          markPreviewReady();
          setPreviewSheet(null);
          router.push('/preview');
        }}
        onShowFail={() => setPreviewSheet('fail')}
        onRetry={() => setPreviewSheet('loading')}
      />
    </Page>
  );
}

const styles = StyleSheet.create({
  outfitTitle: {
    marginTop: 18,
    marginBottom: 6,
  },
  outfitTitleText: {
    color: colors.ink,
  },
  subtitle: {
    fontSize: 12,
    lineHeight: 19,
    color: colors.muted,
    marginTop: 6,
  },
  reason: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginBottom: 13,
  },
  reasonText: {
    flex: 1,
    fontSize: 11,
    lineHeight: 21,
    color: colors.reasonText,
  },
  pieceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  pieceArt: {
    width: 49,
    flexShrink: 0,
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

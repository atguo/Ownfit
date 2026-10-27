import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Page } from '../ui/Screen';
import { BackTitle } from '../ui/PageTop';
import { Button } from '../ui/components/Button';
import { DemoLabel, EmptyState, Notice, Tag } from '../ui/components/Basics';
import { LookArt } from '../ui/components/ItemArt';
import { PreviewSheet, type PreviewSheetState } from '../features/sheets/PreviewSheets';
import { markPreviewReady, saveOutfit, setCompare, useDemoStore } from '../features/demoStore';
import { useToast } from '../ui/components/Toast';
import { colors, radius, type } from '../ui/tokens';

// 上身预览（原型 preview()）：单套/两套比较、过期态；失败体验入口在搭配页弹层中。
// 全程保留“非真实试穿”边界声明；M1 为预制示意，真实预览属 A 线与 M5。
export default function PreviewScreen() {
  const router = useRouter();
  const toast = useToast();
  const store = useDemoStore();
  const [retrySheet, setRetrySheet] = useState<PreviewSheetState>(null);

  const stale = store.previewVersion !== store.version;

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
      <BackTitle title="上身预览" onBack={() => router.back()} />
      <Tag icon="info" label="演示示意 · 非真实试穿" />

      <View style={styles.segmented}>
        <Button
          variant="segmented"
          label="单套查看"
          active={!store.compare}
          onPress={() => setCompare(false)}
        />
        <Button
          variant="segmented"
          label="两套比较"
          active={store.compare}
          onPress={() => setCompare(true)}
        />
      </View>

      {stale ? (
        <EmptyState
          icon="image"
          title="搭配已调整"
          action={{ label: '重新预览', onPress: () => setRetrySheet('loading') }}>
          {'上一张示意图不代表当前方案。\n你可以重新体验预览流程。'}
        </EmptyState>
      ) : store.compare ? (
        <>
          <View style={styles.compare}>
            {[0, 1].map((look) => (
              <View key={look} style={styles.compareCell}>
                <View style={styles.compareArt}>
                  <LookArt look={look} style={styles.fill} />
                  <DemoLabel label={look ? '示例 B' : '示例 A'} />
                </View>
                <Text style={styles.compareCaption}>{look ? '换一件，松弛一点' : '日常的温柔'}</Text>
              </View>
            ))}
          </View>
          <Notice>同一虚构模特、相近姿态与背景。两套为预制示例，不会随上传照片或穿法变化。</Notice>
        </>
      ) : (
        <>
          <View style={styles.single}>
            <LookArt look={store.previewLook} style={styles.fill} />
            <DemoLabel label="演示参考人物" />
          </View>
          <Notice>这是预制的视觉示例，尚未接入 AI。不能据此判断你的实际比例、松紧和衣长。</Notice>
        </>
      )}

      <Button variant="primary" icon="bookmark" label="保存当前搭配" onPress={save} />
      <View style={styles.footerRow}>
        <Text style={styles.footerText}>搭配清单始终保留</Text>
        <Button variant="text" label="返回调整" onPress={() => router.back()} />
      </View>

      {/* 过期态的重新预览：原地走一次 900ms 模拟等待 */}
      <PreviewSheet
        state={retrySheet}
        onClose={() => setRetrySheet(null)}
        onReady={() => {
          markPreviewReady();
          setRetrySheet(null);
        }}
        onShowFail={() => setRetrySheet('fail')}
        onRetry={() => setRetrySheet('loading')}
      />
    </Page>
  );
}

const styles = StyleSheet.create({
  segmented: {
    backgroundColor: colors.soft,
    borderRadius: radius.button,
    padding: 4,
    flexDirection: 'row',
    marginVertical: 16,
  },
  fill: {
    flex: 1,
  },
  single: {
    height: 403,
    borderRadius: radius.empty,
    backgroundColor: '#ECEEEB',
    overflow: 'hidden',
  },
  compare: {
    flexDirection: 'row',
    gap: 8,
  },
  compareCell: {
    flex: 1,
  },
  compareArt: {
    height: 286,
    borderRadius: radius.empty,
    backgroundColor: '#ECEEEB',
    overflow: 'hidden',
  },
  compareCaption: {
    fontSize: 11,
    lineHeight: 16,
    textAlign: 'center',
    marginTop: 8,
    color: colors.ink,
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 23,
    marginBottom: 12,
  },
  footerText: {
    ...type.caption,
    color: colors.muted,
  },
});

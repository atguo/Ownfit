import { useEffect, useRef, useState } from 'react';
import { Sheet } from '../../ui/components/Sheet';
import { LoadingBlock, Notice } from '../../ui/components/Basics';
import { Button } from '../../ui/components/Button';
import { colors, type } from '../../ui/tokens';
import { StyleSheet, Text } from 'react-native';

// 预览流程弹层（原型 startPreview/preview-fail）：
// loading 态 900ms 后自动完成并回调 onReady；失败态为原型内置的体验入口。

export type PreviewSheetState = 'loading' | 'fail' | null;

export function PreviewSheet({
  state,
  onClose,
  onReady,
  onShowFail,
  onRetry,
}: {
  state: PreviewSheetState;
  onClose: () => void;
  /** loading 900ms 计时完成后回调（仅当弹层仍是 loading 态） */
  onReady: () => void;
  /** 从 loading 切到失败体验态 */
  onShowFail: () => void;
  /** 失败态的重新尝试：回到 loading */
  onRetry: () => void;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (state === 'loading') {
      timer.current = setTimeout(onReady, 900);
    }
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [state, onReady]);

  return (
    <>
      <Sheet visible={state === 'loading'} title="正在准备示意" onClose={onClose}>
        <LoadingBlock title="让搭配更直观一点。">
          正在模拟生成等待状态，未调用 AI 服务。
        </LoadingBlock>
        <Button variant="text" label="体验失败状态" onPress={onShowFail} />
      </Sheet>

      <Sheet visible={state === 'fail'} title="这次预览没有完成。" onClose={onClose}>
        <Text style={styles.description}>
          这是原型的模拟失败状态。搭配清单和修改都还在，可以重试，或稍后再看。
        </Text>
        <Button variant="primary" label="重新尝试" onPress={onRetry} />
        <Button variant="text" label="回到搭配清单" onPress={onClose} />
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  description: {
    ...type.caption,
    color: colors.muted,
    lineHeight: 23,
    marginBottom: 15,
  },
});

// 原型 startPreview 的参考引导弹层：未准备人物参考时先出现
export function ReferencePrepareSheet({
  visible,
  onClose,
  onUseDemo,
}: {
  visible: boolean;
  onClose: () => void;
  onUseDemo: () => void;
}) {
  return (
    <Sheet visible={visible} title="先准备人物参考。" onClose={onClose}>
      <Text style={styles.description}>
        真实预览需要你的照片。本原型不收集人物照片，可以使用虚构人物体验流程。
      </Text>
      <Notice>两套预制示意只展示界面，不会根据你的衣服、身材或穿法重新生成。</Notice>
      <Button variant="primary" label="使用演示人物，继续" onPress={onUseDemo} />
      <Button variant="text" label="先看搭配清单" onPress={onClose} />
    </Sheet>
  );
}

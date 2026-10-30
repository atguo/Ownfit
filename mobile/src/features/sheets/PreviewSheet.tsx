// 上身预览面板（M5 轨 A3）：从当前搭配会话发起生成，展示任务状态、结果图与历史。
// 诚实边界：AI 生成示意图 ≠ 真实试穿；方案变化后的旧预览明确标注，不冒充当前方案结果。

import { useCallback, useEffect, useState } from 'react';
import { Alert, Image, StyleSheet, Text, View } from 'react-native';
import { Sheet } from '../../ui/components/Sheet';
import { Button } from '../../ui/components/Button';
import { Notice, Tag } from '../../ui/components/Basics';
import { useToast } from '../../ui/components/Toast';
import {
  enqueuePreview,
  initPreviewRunner,
  rememberDefaultImageGenConfig,
  resolveImageGenForPreview,
  subscribePreviewChanges,
} from '../previewStore';
import {
  listRecentPreviewTasks,
  previewImageUri,
  type PreviewTask,
} from '../../data/repositories/previewRepository';
import type { ConfigResolution } from '../../services/ai/visionConfig';
import { callRevisionOf } from '../../services/ai/types';
import { colors, type } from '../../ui/tokens';

function sameItems(a: string[], b: string[]): boolean {
  const key = (ids: string[]) => [...ids].sort().join('|');
  return key(a) === key(b);
}

function statusLine(task: PreviewTask): string {
  switch (task.status) {
    case 'queued':
      return '排队中…';
    case 'running':
      return '生成中…（约 1-2 分钟）';
    case 'succeeded':
      return `生成完成 ${task.finishedAt?.slice(5, 16).replace('T', ' ') ?? ''}`;
    case 'failed':
      return `生成失败：${task.errorSummary ?? '未知原因'}`;
    case 'interrupted':
      return '结果未知（可能超时或断网），可重试';
    case 'blocked':
      return task.errorSummary ?? '模型配置已变化，请重新选择';
    default:
      return '已取消';
  }
}

export function PreviewSheet({
  visible,
  onClose,
  basisItemId,
  itemIds,
  wearStyle,
}: {
  visible: boolean;
  onClose: () => void;
  basisItemId: string;
  itemIds: string[];
  wearStyle: string;
}) {
  const toast = useToast();
  const [resolution, setResolution] = useState<ConfigResolution | null>(null);
  const [tasks, setTasks] = useState<PreviewTask[]>([]);
  const [starting, setStarting] = useState(false);

  const reload = useCallback(async () => {
    setTasks(await listRecentPreviewTasks(8));
  }, []);

  useEffect(() => {
    if (!visible) {
      initPreviewRunner().setForeground(false);
      return;
    }
    const runner = initPreviewRunner();
    runner.start();
    void runner
      .recover()
      .catch(() => undefined)
      .then(() => runner.setForeground(true));
    void resolveImageGenForPreview().then(setResolution);
    void reload();
    return subscribePreviewChanges(() => void reload());
  }, [visible, reload]);

  function start(configId: string) {
    setStarting(true);
    void (async () => {
      try {
        const result = await enqueuePreview({ basisItemId, itemIds, wearStyle, configId });
        if (result.status === 'rejected') {
          Alert.alert(
            '还没有人物参考',
            '生成上身预览需要一张你本人的正面照片作参考（只存本机，仅发送给你配置的图像生成服务）。\n到「我的 → 人物参考」从相册选择一张。',
            [{ text: '知道了' }],
          );
          return;
        }
        toast(result.status === 'created' ? '已开始生成预览' : '本方案已有生成任务在进行');
        void reload();
      } finally {
        setStarting(false);
      }
    })();
  }

  function onPressGenerate() {
    if (!resolution) return;
    if (resolution.status === 'missing') {
      Alert.alert(
        '还没有图像生成模型',
        '上身预览使用图像生成服务（如 MiniMax image-01）。\n到「我的 → 模型配置」添加配置，能力勾选“图像生成”。',
        [{ text: '知道了' }],
      );
      return;
    }
    if (resolution.status === 'invalid') {
      Alert.alert('模型配置不可用', resolution.message, [{ text: '知道了' }]);
      return;
    }
    if (resolution.status === 'choose') {
      // 多个候选：保持 choose 状态由下方候选列表选择，不静默切换供应商
      return;
    }
    start(resolution.config.id);
  }

  return (
    <Sheet visible={visible} title="上身预览" onClose={onClose}>
      <Notice>AI 生成示意图，非真实试穿。最终效果以你的实际穿着为准。</Notice>

      {resolution?.status === 'choose' ? (
        <View>
          <Text style={styles.note}>有多个可用的图像生成模型，选择一个（会记住）：</Text>
          {resolution.candidates.map((config) => (
            <Button
              key={config.id}
              variant="chip"
              label={`${config.name} · ${config.modelId}`}
              onPress={() => {
                void rememberDefaultImageGenConfig(config.id).then(() => {
                  setResolution({ status: 'ready', config, callRevision: callRevisionOf(config) });
                });
              }}
              style={styles.gap}
            />
          ))}
        </View>
      ) : null}

      <Button
        variant="primary"
        label={starting ? '正在提交…' : '生成上身预览'}
        onPress={onPressGenerate}
        disabled={starting}
      />

      <Text style={styles.sectionTitle}>生成记录</Text>
      {tasks.length === 0 ? (
        <Text style={styles.note}>还没有生成记录。点击上方按钮生成当前搭配的预览。</Text>
      ) : null}
      {tasks.map((task) => {
        const current = sameItems(task.itemIds, itemIds) && task.wearStyle === wearStyle;
        return (
          <View key={task.id} style={styles.taskCard}>
            <View style={styles.taskHead}>
              <Tag label={current ? '本方案' : '方案已变化'} />
              <Text style={styles.taskStatus}>{statusLine(task)}</Text>
            </View>
            {task.status === 'succeeded' && task.resultPreviewPath ? (
              <Image
                source={{ uri: previewImageUri(task.resultPreviewPath) }}
                style={styles.previewImage}
                resizeMode="contain"
                accessibilityLabel="上身预览示意图"
              />
            ) : null}
            {task.status === 'failed' || task.status === 'interrupted' || task.status === 'blocked' ? (
              <Button
                variant="secondary"
                label={resolution?.status === 'ready' ? '重试' : '重试（需先选择模型）'}
                onPress={() => {
                  if (resolution?.status === 'ready') {
                    start(resolution.config.id);
                  } else {
                    void resolveImageGenForPreview().then(setResolution);
                  }
                }}
                style={styles.gap}
              />
            ) : null}
          </View>
        );
      })}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  note: {
    ...type.footnote,
    color: colors.muted,
    lineHeight: 18,
    marginBottom: 10,
  },
  sectionTitle: {
    ...type.sectionHead,
    color: colors.ink,
    marginTop: 16,
    marginBottom: 8,
  },
  taskCard: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    padding: 10,
    marginBottom: 10,
  },
  taskHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  taskStatus: {
    ...type.footnote,
    color: colors.ink,
    flex: 1,
  },
  previewImage: {
    width: '100%',
    height: 260,
    borderRadius: 8,
    backgroundColor: colors.artBg,
  },
  gap: {
    marginTop: 8,
  },
});

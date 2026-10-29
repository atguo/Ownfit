// 视觉模型选择弹层（分批执行手册 D1 / P6）。
// 只在“有多个可用视觉候选且没有可用默认”时出现（由 resolveVisionConfig 的 choose 分支触发）；
// 选择结果由调用方记住为默认，避免静默切换供应商。

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Sheet } from '../../ui/components/Sheet';
import { capabilityLabels, urlKindLabels, type ModelConfig } from '../../services/ai/types';
import { colors, radius, type } from '../../ui/tokens';

export interface VisionModelSheetProps {
  visible: boolean;
  candidates: ModelConfig[];
  onSelect: (configId: string) => void;
  onClose: () => void;
}

export function VisionModelSheet({ visible, candidates, onSelect, onClose }: VisionModelSheetProps) {
  return (
    <Sheet visible={visible} title="选择图片理解模型" onClose={onClose}>
      <Text style={styles.hint}>
        {'有多个可用的图片理解模型，选择其中一个用于衣物分析。\n选择会记住，之后同类分析默认使用它。'}
      </Text>
      {candidates.map((config) => (
        <Pressable
          key={config.id}
          accessibilityRole="button"
          accessibilityLabel={`使用 ${config.name}`}
          onPress={() => onSelect(config.id)}
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
          <View style={styles.rowText}>
            <Text style={styles.name}>{config.name}</Text>
            <Text style={styles.meta}>
              {urlKindLabels[config.urlKind]} · {config.modelId}
            </Text>
            <View style={styles.badgeRow}>
              {config.capabilities.map((capability) => (
                <View key={capability} style={styles.badge}>
                  <Text style={styles.badgeText}>{capabilityLabels[capability]}</Text>
                </View>
              ))}
            </View>
          </View>
          <Text style={styles.chevron}>›</Text>
        </Pressable>
      ))}
      <Text style={styles.footnote}>
        这里的模型由你自行配置与付费；分析会把这一件衣服的照片发送到所选服务。
      </Text>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  hint: {
    ...type.caption,
    color: colors.muted,
    lineHeight: 23,
    marginBottom: 14,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 15,
    paddingHorizontal: 14,
    borderRadius: radius.notice,
    backgroundColor: colors.soft,
    marginBottom: 10,
  },
  rowPressed: {
    opacity: 0.75,
  },
  rowText: {
    flex: 1,
  },
  name: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '500',
    lineHeight: 20,
  },
  meta: {
    color: colors.muted,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 3,
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
    flexWrap: 'wrap',
  },
  badge: {
    backgroundColor: colors.tagBg,
    borderRadius: 5,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  badgeText: {
    color: colors.tagText,
    fontSize: 10,
    lineHeight: 14,
  },
  chevron: {
    color: colors.muted,
    fontSize: 22,
    marginLeft: 8,
  },
  footnote: {
    ...type.footnote,
    color: colors.subtleInfo,
    lineHeight: 20,
    marginTop: 6,
  },
});

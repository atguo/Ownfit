import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { Page } from '../../ui/Screen';
import { BackTitle } from '../../ui/PageTop';
import { Button } from '../../ui/components/Button';
import { Notice } from '../../ui/components/Basics';
import { loadConfigs } from '../../services/ai/configStore';
import { capabilityLabels, urlKindLabels, type ModelConfig } from '../../services/ai/types';
import { colors, radius } from '../../ui/tokens';

const testStatusLabels: Record<ModelConfig['testStatus'], { text: string; color: string }> = {
  untested: { text: '未测试', color: colors.muted },
  passed: { text: '测试通过', color: colors.tagText },
  failed: { text: '测试失败', color: '#b0563f' },
};

// AI 模型配置列表（AI模型配置与接入.md：四项手动配置 + 模型 ID；密钥只存设备安全存储）。
export default function AiConfigListScreen() {
  const router = useRouter();
  const [configs, setConfigs] = useState<ModelConfig[]>([]);
  const [loaded, setLoaded] = useState(false);

  useFocusEffect(
    useCallback(() => {
      setConfigs(loadConfigs());
      setLoaded(true);
    }, []),
  );

  return (
    <Page>
      <BackTitle title="模型配置" onBack={() => router.back()} />
      <Notice>
        {'配置只保存在本机：连接信息存应用目录，API Key 存设备安全存储（不进入日志与备份）。'}
        {'\n'}配置成功 ≠ 连接可用：每条配置可用“测试连接”验证。
      </Notice>

      {configs.map((config) => {
        const status = testStatusLabels[config.testStatus];
        return (
          <Pressable
            key={config.id}
            accessibilityRole="button"
            onPress={() => router.push({ pathname: '/ai/config-edit', params: { id: config.id } })}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
            <View style={styles.rowTextWrap}>
              <Text style={styles.rowName}>{config.name}</Text>
              <Text style={styles.rowMeta}>
                {urlKindLabels[config.urlKind]} · {config.modelId}
              </Text>
              <View style={styles.badgeRow}>
                {config.capabilities.map((capability) => (
                  <View key={capability} style={styles.badge}>
                    <Text style={styles.badgeText}>{capabilityLabels[capability]}</Text>
                  </View>
                ))}
                <Text style={[styles.statusText, { color: status.color }]}>● {status.text}</Text>
              </View>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        );
      })}

      {loaded && configs.length === 0 ? (
        <Notice>还没有配置 AI 服务。添加后即可在后续版本中调用解析与预览能力。</Notice>
      ) : null}

      <Button
        variant="primary"
        icon="plus"
        label="添加配置"
        onPress={() => router.push('/ai/config-edit')}
        style={styles.addButton}
      />
    </Page>
  );
}

const styles = StyleSheet.create({
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
  rowTextWrap: {
    flex: 1,
  },
  rowName: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '500',
    lineHeight: 20,
  },
  rowMeta: {
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
  statusText: {
    fontSize: 10,
    lineHeight: 14,
  },
  chevron: {
    color: colors.muted,
    fontSize: 22,
    marginLeft: 8,
  },
  addButton: {
    marginTop: 17,
  },
});

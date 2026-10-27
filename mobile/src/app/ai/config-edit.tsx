import { useEffect, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Page } from '../../ui/Screen';
import { BackTitle } from '../../ui/PageTop';
import { Button } from '../../ui/components/Button';
import { Notice } from '../../ui/components/Basics';
import { Field, TextField } from '../../ui/components/Field';
import { useToast } from '../../ui/components/Toast';
import {
  addConfig,
  deleteConfig,
  getConfig,
  updateConfig,
} from '../../services/ai/configStore';
import { testConnection } from '../../services/ai/testConnection';
import {
  capabilityLabels,
  urlKindLabels,
  type AiCapability,
  type ModelConfig,
  type UrlKind,
} from '../../services/ai/types';
import { colors, radius } from '../../ui/tokens';

const capabilityOptions: AiCapability[] = ['text', 'vision'];
const defaultsByKind: Record<UrlKind, AiCapability[]> = {
  openai: ['text', 'vision'],
  minimax: ['image_gen'],
};

type TestState =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'done'; ok: boolean; message: string };

// 配置表单：新增（无 id）与编辑（有 id）共用。
export default function AiConfigEditScreen() {
  const router = useRouter();
  const toast = useToast();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const existing = id ? getConfig(id) : undefined;

  const [name, setName] = useState(existing?.name ?? '');
  const [urlKind, setUrlKind] = useState<UrlKind>(existing?.urlKind ?? 'openai');
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? '');
  const [modelId, setModelId] = useState(existing?.modelId ?? '');
  const [capabilities, setCapabilities] = useState<AiCapability[]>(
    existing?.capabilities ?? defaultsByKind[existing?.urlKind ?? 'openai'],
  );
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<TestState>({ phase: 'idle' });

  // 编辑已保存的配置时回填（getConfig 是同步读文件，挂载时执行一次即可）
  useEffect(() => {
    if (existing && !name && !baseUrl) {
      setName(existing.name);
      setUrlKind(existing.urlKind);
      setBaseUrl(existing.baseUrl);
      setModelId(existing.modelId);
      setCapabilities(existing.capabilities);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isMinimax = urlKind === 'minimax';

  function changeUrlKind(kind: UrlKind) {
    setUrlKind(kind);
    setCapabilities(defaultsByKind[kind]);
  }

  function toggleCapability(capability: AiCapability) {
    setCapabilities((prev) =>
      prev.includes(capability) ? prev.filter((c) => c !== capability) : [...prev, capability],
    );
  }

  function buildDraft(): ModelConfig {
    return {
      id: existing?.id ?? 'draft',
      name,
      urlKind,
      baseUrl,
      modelId,
      capabilities,
      keyRef: existing?.keyRef ?? '',
      hasKey: existing?.hasKey ?? false,
      testStatus: 'untested',
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  function validate(): string | null {
    if (!name.trim()) return '请填写名称';
    if (!baseUrl.trim()) return '请填写服务地址';
    if (!modelId.trim()) return '请填写模型 ID';
    if (!existing && !apiKey.trim()) return '请填写 API Key';
    if (!capabilities.length) return '请至少选择一项能力';
    return null;
  }

  async function save() {
    const problem = validate();
    if (problem) {
      toast(problem);
      return;
    }
    setSaving(true);
    try {
      const input = {
        name: name.trim(),
        urlKind,
        baseUrl: baseUrl.trim(),
        modelId: modelId.trim(),
        capabilities,
        apiKey: apiKey.trim() || undefined,
      };
      if (existing) {
        await updateConfig(existing.id, input);
      } else {
        await addConfig(input);
      }
      toast('已保存（尚未测试连接）');
      router.back();
    } finally {
      setSaving(false);
    }
  }

  async function runTest() {
    const problem = validate();
    if (problem) {
      toast(problem);
      return;
    }
    setTest({ phase: 'running' });
    const result = await testConnection(buildDraft(), apiKey.trim() || undefined);
    setTest({ phase: 'done', ok: result.ok, message: result.message });
  }

  async function remove() {
    if (!existing) return;
    Alert.alert('删除这条配置？', `“${existing.name}” 将被删除，其 API Key 也会从安全存储中清除。此操作不可恢复。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          await deleteConfig(existing.id);
          toast('配置已删除');
          router.back();
        },
      },
    ]);
  }

  return (
    <Page>
      <BackTitle title={existing ? '编辑配置' : '添加配置'} onBack={() => router.back()} />

      <Field label="名称（展示用）">
        <TextField value={name} onChangeText={setName} placeholder="例如：智谱 GLM" maxLength={30} />
      </Field>

      <Field label="URL 类型">
        <View style={styles.chipRow}>
          {(Object.keys(urlKindLabels) as UrlKind[]).map((kind) => (
            <Button
              key={kind}
              variant="chip"
              label={urlKindLabels[kind]}
              active={urlKind === kind}
              onPress={() => changeUrlKind(kind)}
            />
          ))}
        </View>
      </Field>

      <Field label="服务地址（基础地址，接口路径自动拼接）">
        <TextField
          value={baseUrl}
          onChangeText={setBaseUrl}
          placeholder={isMinimax ? 'https://api.minimaxi.com' : 'https://api.example.com/v1'}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
      </Field>

      <Field label="模型 ID（请求用）">
        <TextField
          value={modelId}
          onChangeText={setModelId}
          placeholder={isMinimax ? 'image-01' : 'glm-4v-flash'}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </Field>

      <Field label="能力（决定后续任务使用哪条配置）">
        {isMinimax ? (
          <View style={styles.chipRow}>
            <Button variant="chip" label={capabilityLabels.image_gen} active disabled />
          </View>
        ) : (
          <View style={styles.chipRow}>
            {capabilityOptions.map((capability) => (
              <Button
                key={capability}
                variant="chip"
                label={capabilityLabels[capability]}
                active={capabilities.includes(capability)}
                onPress={() => toggleCapability(capability)}
              />
            ))}
          </View>
        )}
      </Field>

      <Field label="API Key">
        <TextField
          value={apiKey}
          onChangeText={setApiKey}
          placeholder={existing?.hasKey ? '已保存（输入可覆盖）' : 'sk-...'}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
        />
      </Field>

      <Notice>
        {isMinimax
          ? 'MiniMax 图像协议的“测试连接”会实际生成一张测试图，产生少量费用。'
          : '“测试连接”发送一次极小的文本请求。'}
        {'\n'}Key 只保存在设备安全存储，不进入日志与备份。
      </Notice>

      {test.phase === 'done' ? (
        <View style={[styles.testResult, test.ok ? styles.testOk : styles.testFail]}>
          <Text style={styles.testResultText}>{test.ok ? '✓ ' : '✗ '}{test.message}</Text>
        </View>
      ) : null}

      <Button
        variant="secondary"
        label={test.phase === 'running' ? '测试中…' : '测试连接'}
        onPress={runTest}
        disabled={test.phase === 'running'}
      />
      <Button
        variant="primary"
        label="保存"
        onPress={save}
        disabled={saving}
        style={styles.saveGap}
      />
      {existing ? (
        <Button variant="text" label="删除这条配置" onPress={remove} />
      ) : null}
    </Page>
  );
}

const styles = StyleSheet.create({
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 8,
  },
  testResult: {
    borderRadius: radius.notice,
    paddingHorizontal: 13,
    paddingVertical: 12,
    marginBottom: 13,
  },
  testOk: {
    backgroundColor: colors.tagBg,
  },
  testFail: {
    backgroundColor: '#f6e8e3',
  },
  testResultText: {
    color: colors.ink,
    fontSize: 12,
    lineHeight: 18,
  },
  saveGap: {
    marginTop: 10,
  },
});

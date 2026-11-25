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
  ensureConfigCache,
  getConfig,
  updateConfig,
  updateTestResult,
} from '../../services/ai/configStore';
import { testConnection } from '../../services/ai/clients/testConnection';
import {
  capabilityLabels,
  insecureUrlProblem,
  isImageGenUrlKind,
  urlKindLabels,
  type AiCapability,
  type ModelConfig,
  type UrlKind,
} from '../../services/ai/types';
import { colors, radius } from '../../ui/tokens';

const capabilityOptions: AiCapability[] = ['text', 'vision'];
const defaultsByKind: Record<UrlKind, AiCapability[]> = {
  openai: ['text', 'vision'],
  openai_images: ['image_gen'],
  minimax: ['image_gen'],
};

type TestState =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'done'; ok: boolean; message: string; fingerprint: string; testedAt: string };

/** 影响实际调用的连接参数指纹：用于判定刚完成的测试结果是否仍对应当前表单输入 */
function connectionFingerprint(params: {
  urlKind: UrlKind;
  baseUrl: string;
  modelId: string;
  capabilities: AiCapability[];
  apiKey: string;
}): string {
  return JSON.stringify([
    params.urlKind,
    params.baseUrl.trim(),
    params.modelId.trim(),
    [...params.capabilities].sort(),
    params.apiKey.trim(),
  ]);
}

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

  // 编辑已保存的配置时回填；镜像未就绪时先加载再回填（M6 批次 1.4：配置已迁本地库）
  useEffect(() => {
    void ensureConfigCache().then(() => {
      const loaded = id ? getConfig(id) : undefined;
      if (loaded && !name && !baseUrl) {
        setName(loaded.name);
        setUrlKind(loaded.urlKind);
        setBaseUrl(loaded.baseUrl);
        setModelId(loaded.modelId);
        setCapabilities(loaded.capabilities);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isMinimax = urlKind === 'minimax';
  const isOpenAIImages = urlKind === 'openai_images';
  const isImageGenKind = isImageGenUrlKind(urlKind);
  const currentFingerprint = connectionFingerprint({
    urlKind,
    baseUrl,
    modelId,
    capabilities,
    apiKey,
  });
  const matchingTest =
    test.phase === 'done' && test.fingerprint === currentFingerprint ? test : null;

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
    // 明文收敛（M6 批次 2）：服务地址只接受 https
    const insecure = insecureUrlProblem(baseUrl);
    if (insecure) return insecure;
    if (isMinimax && !/\/[a-z]/i.test(baseUrl.trim().replace(/^https?:\/\//i, ''))) {
      return '图像服务需填写完整接口地址（含路径，如 /v1/images/edits 或 /v1/image_generation）';
    }
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
        ...(matchingTest
          ? {
              testResult: {
                testStatus: matchingTest.ok ? ('passed' as const) : ('failed' as const),
                testMessage: matchingTest.message,
                testedAt: matchingTest.testedAt,
              },
            }
          : null),
      };
      const saved = existing ? await updateConfig(existing.id, input) : await addConfig(input);
      const statusText =
        saved?.testStatus === 'passed'
          ? '已保存（连接测试通过）'
          : saved?.testStatus === 'failed'
            ? '已保存（最近测试失败）'
            : '已保存（尚未测试连接）';
      toast(statusText);
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
    const testedFingerprint = currentFingerprint;
    const matchesSavedConfig =
      !!existing &&
      testedFingerprint ===
        connectionFingerprint({
          urlKind: existing.urlKind,
          baseUrl: existing.baseUrl,
          modelId: existing.modelId,
          capabilities: existing.capabilities,
          apiKey: '',
        });
    setTest({ phase: 'running' });
    const result = await testConnection(buildDraft(), apiKey.trim() || undefined);
    const testedAt = new Date().toISOString();
    // 仅当测试的是已保存配置的原参数时直接写回存储；新增草稿或已修改参数在点击“保存”时一并落库
    if (existing && matchesSavedConfig) {
      await updateTestResult(existing.id, {
        testStatus: result.ok ? 'passed' : 'failed',
        testMessage: result.message,
      });
    }
    setTest({
      phase: 'done',
      ok: result.ok,
      message: result.message,
      fingerprint: testedFingerprint,
      testedAt,
    });
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

      <Field
        label={
          isMinimax
            ? '服务地址（完整 API 地址，直接调用不拼接）'
            : isOpenAIImages
              ? '服务地址（填到版本号为止，自动拼接 /images/generations；也可直接填完整路径）'
              : '服务地址（填到版本号为止，自动拼接 /chat/completions）'
        }
      >
        <TextField
          value={baseUrl}
          onChangeText={setBaseUrl}
          placeholder={
            isMinimax
              ? 'https://api.minimax.cn/v1/images/edits'
              : isOpenAIImages
                ? 'https://ark.cn-beijing.volces.com/api/v3'
                : 'https://api.example.com/v1'
          }
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
      </Field>

      <Field label="模型 ID（请求用）">
        <TextField
          value={modelId}
          onChangeText={setModelId}
          placeholder={
            isMinimax
              ? 'MiniMax-H3-Image'
              : isOpenAIImages
                ? 'doubao-seedream-5-0-flash-260915'
                : 'glm-4v-flash'
          }
          autoCapitalize="none"
          autoCorrect={false}
        />
      </Field>

      <Field label="能力（决定后续任务使用哪条配置）">
        {isImageGenKind ? (
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
          : isOpenAIImages
            ? 'OpenAI 图像兼容协议支持火山方舟 Seedream 等多图参考接口；“测试连接”会实际生成一张测试图，产生少量费用。'
            : '“测试连接”发送一次极小的文本请求。'}
        {'\n'}Key 只保存在设备安全存储，不进入日志与备份。
      </Notice>

      {test.phase === 'done' ? (
        <View style={[styles.testResult, test.ok ? styles.testOk : styles.testFail]}>
          <Text style={styles.testResultText}>
            {test.ok ? '✓ ' : '✗ '}
            {test.message}
            {!matchingTest ? '\n配置参数已修改，当前结果不适用于修改后的配置，保存后将标记为未测试。' : ''}
          </Text>
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

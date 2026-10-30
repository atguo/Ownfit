import { useCallback, useEffect, useState } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ToastProvider } from '../ui/components/Toast';
import { Button } from '../ui/components/Button';
import { initGarmentTaskRunner } from '../features/garmentAnalysisStore';
import { getLastDbInitFailure, getDb, type DbInitFailure } from '../data/db';
import { colors, radius, type } from '../ui/tokens';

// 根布局：Stack 承载四个 Tab 主入口与任务内页面；浅色主题由 app.json userInterfaceStyle
// + expo-system-ui 在原生层锁定。
// 同时负责初始化衣物分析任务执行器：模块单例（React 重挂载不重复启动）、启动恢复、
// 前台才领取新任务。初始化失败只提示，不影响已保存的草稿与其他功能。
// 数据库初始化失败时进入"资料安全模式"：明确提示失败阶段与"资料保持原样"，提供重试；
// 不静默降级、不清库（M4）。

const STAGE_TEXT: Record<DbInitFailure['stage'], string> = {
  open: '数据库未能打开',
  key: '数据库密钥校验失败',
  migrate: '资料升级未能完成',
};

export default function RootLayout() {
  const [initFailed, setInitFailed] = useState(false);
  const [dbFailure, setDbFailure] = useState<DbInitFailure | null>(null);

  const probeDb = useCallback(async () => {
    try {
      await getDb();
      setDbFailure(null);
    } catch {
      setDbFailure(getLastDbInitFailure() ?? { stage: 'open', message: '初始化失败' });
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    const runner = initGarmentTaskRunner();
    runner.start();

    (async () => {
      try {
        // 启动时把遗留的 running 任务标为中断（不重发），然后在前台开始领取 queued
        await runner.recover();
        if (mounted) runner.setForeground(AppState.currentState === 'active');
      } catch {
        if (mounted) setInitFailed(true);
      }
    })();

    // M4 安全模式：启动即探测数据库；失败时全局提示并允许重试
    void probeDb();

    const subscription = AppState.addEventListener('change', (next) => {
      runner.setForeground(next === 'active');
    });

    return () => {
      mounted = false;
      subscription.remove();
      runner.setForeground(false);
    };
  }, [probeDb]);

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <ToastProvider>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="choose" />
          <Stack.Screen name="outfit" />
          <Stack.Screen name="add" />
          <Stack.Screen name="ai/config" />
          <Stack.Screen name="ai/config-edit" />
          <Stack.Screen name="dev/components" />
          <Stack.Screen name="dev/data-tools" />
        </Stack>
        {dbFailure ? (
          <View style={styles.safeMode}>
            <Text style={styles.safeModeTitle}>
              {STAGE_TEXT[dbFailure.stage]}，资料保持原样（不会清库）
            </Text>
            <Text style={styles.safeModeText}>
              {`在重试成功前，衣橱与搭配等本地功能不可用；你的照片与资料没有丢失。失败详情：${dbFailure.message}`}
            </Text>
            <Button variant="text" label="重试" onPress={() => void probeDb()} />
          </View>
        ) : null}
        {initFailed ? (
          <View style={styles.banner} pointerEvents="none">
            <Text style={styles.bannerText}>
              衣物分析的自动处理未能启动，已保存的照片与草稿不受影响；重新打开应用可再试一次。
            </Text>
          </View>
        ) : null}
      </ToastProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 24,
    padding: 12,
    borderRadius: radius.notice,
    backgroundColor: colors.soft,
  },
  bannerText: {
    ...type.footnote,
    color: colors.ink,
    lineHeight: 20,
  },
  safeMode: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 24,
    padding: 14,
    borderRadius: radius.notice,
    backgroundColor: colors.ink,
  },
  safeModeTitle: {
    ...type.sectionHead,
    color: colors.bg,
    marginBottom: 6,
  },
  safeModeText: {
    ...type.footnote,
    color: colors.soft,
    lineHeight: 18,
  },
});

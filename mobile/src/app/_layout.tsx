import { useEffect, useState } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ToastProvider } from '../ui/components/Toast';
import { initGarmentTaskRunner } from '../features/garmentAnalysisStore';
import { colors, radius, type } from '../ui/tokens';

// 根布局：Stack 承载四个 Tab 主入口与任务内页面；浅色主题由 app.json userInterfaceStyle
// + expo-system-ui 在原生层锁定。
// 同时负责初始化衣物分析任务执行器：模块单例（React 重挂载不重复启动）、启动恢复、
// 前台才领取新任务。初始化失败只提示，不影响已保存的草稿与其他功能。
export default function RootLayout() {
  const [initFailed, setInitFailed] = useState(false);

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

    const subscription = AppState.addEventListener('change', (next) => {
      runner.setForeground(next === 'active');
    });

    return () => {
      mounted = false;
      subscription.remove();
      runner.setForeground(false);
    };
  }, []);

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
        </Stack>
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
});

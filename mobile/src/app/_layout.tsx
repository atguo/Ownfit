import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ToastProvider } from '../ui/components/Toast';

// 根布局：Stack 承载四个 Tab 主入口与任务内页面；浅色主题由 app.json userInterfaceStyle
// + expo-system-ui 在原生层锁定。
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <ToastProvider>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(tabs)" />
        <Stack.Screen name="choose" />
        <Stack.Screen name="outfit" />
        <Stack.Screen name="preview" />
        <Stack.Screen name="add" />
        <Stack.Screen name="ai/config" />
        <Stack.Screen name="ai/config-edit" />
        <Stack.Screen name="dev/components" />
        </Stack>
      </ToastProvider>
    </SafeAreaProvider>
  );
}

import { Tabs } from 'expo-router';

// 四个主入口与原型一致：今天、衣橱、搭配、我的。
// 图标与视觉令牌在 M1 设计系统中补充，当前仅文字标签。
export default function TabsLayout() {
  return (
    <Tabs screenOptions={{ headerShown: false }}>
      <Tabs.Screen name="index" options={{ title: '今天' }} />
      <Tabs.Screen name="wardrobe" options={{ title: '衣橱' }} />
      <Tabs.Screen name="outfits" options={{ title: '搭配' }} />
      <Tabs.Screen name="profile" options={{ title: '我的' }} />
    </Tabs>
  );
}

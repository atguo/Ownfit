import { Tabs } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { Icon, type IconName } from '../../ui/Icon';
import { colors } from '../../ui/tokens';

// 四个主入口与原型一致：今天、衣橱、搭配、我的。
// Tab 视觉对应原型 .bottom-nav/.nav-item：10dp 文字、未选中 #858c82、选中墨绿 + 4dp 圆点。

const tabs: { name: string; title: string; icon: IconName }[] = [
  { name: 'index', title: '今天', icon: 'home' },
  { name: 'wardrobe', title: '衣橱', icon: 'closet' },
  { name: 'outfits', title: '搭配', icon: 'bookmark' },
  { name: 'profile', title: '我的', icon: 'user' },
];

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.green,
        tabBarInactiveTintColor: colors.tabInactive,
        tabBarStyle: styles.tabBar,
        tabBarLabel: ({ focused, children }) => (
          <Text style={[styles.label, focused && styles.labelActive]}>{children}</Text>
        ),
      }}>
      {tabs.map((tab) => (
        <Tabs.Screen
          key={tab.name}
          name={tab.name}
          options={{
            title: tab.title,
            tabBarIcon: ({ focused }) => (
              <View style={styles.iconWrap}>
                <Icon name={tab.icon} size={22} color={focused ? colors.green : colors.tabInactive} />
                {focused ? <View style={styles.dot} /> : null}
              </View>
            ),
          }}
        />
      ))}
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.tabBg,
  },
  label: {
    fontSize: 10,
    lineHeight: 14,
    color: colors.tabInactive,
  },
  labelActive: {
    color: colors.green,
    fontWeight: '600',
  },
  iconWrap: {
    alignItems: 'center',
    gap: 4,
  },
  dot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.green,
  },
});

import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useContentMaxWidth } from './responsive';

// 占位屏容器：安全区域 + 大屏内容限宽。M1 按原型实现真实页面后替换。
export function PlaceholderScreen({ title, hint }: { title: string; hint: string }) {
  const insets = useSafeAreaInsets();
  const maxWidth = useContentMaxWidth();

  return (
    <View
      style={[
        styles.container,
        { paddingTop: insets.top, paddingBottom: insets.bottom },
      ]}
    >
      <View style={[styles.content, maxWidth != null && { maxWidth }]}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.hint}>{hint}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  content: {
    width: '100%',
    alignItems: 'center',
    gap: 8,
  },
  title: {
    fontSize: 24,
    fontWeight: '600',
  },
  hint: {
    fontSize: 13,
    color: '#666',
    textAlign: 'center',
  },
});

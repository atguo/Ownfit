import { KeyboardAvoidingView, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useContentMaxWidth } from './responsive';
import { colors } from './tokens';

// 页面容器：对应原型 .page（左右 23、上 10、下 24）+ 安全区域；大屏限宽居中。
// Android edge-to-edge 下 adjustResize 失效，统一用 KeyboardAvoidingView 抬升内容，
// 保证键盘不遮挡输入框与吸底主操作（M1 验收条件）。
// footer 为吸底操作区（原型 .fixed-action），背景同页面底色、避开手势区。

export function Page({
  children,
  footer,
}: {
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const maxWidth = useContentMaxWidth();

  return (
    <View style={styles.flex}>
      <KeyboardAvoidingView behavior="padding" style={styles.flex}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[
            styles.content,
            { paddingTop: insets.top + 10, paddingBottom: insets.bottom + 24 },
          ]}>
          <View style={maxWidth != null ? styles.limited : null}>{children}</View>
        </ScrollView>
      </KeyboardAvoidingView>
      {footer ? (
        <View style={[styles.footer, { paddingBottom: insets.bottom + 8 }]}>
          <View style={maxWidth != null ? styles.limited : null}>{footer}</View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    paddingHorizontal: 23,
  },
  limited: {
    width: '100%',
    maxWidth: 600,
    alignSelf: 'center',
  },
  footer: {
    backgroundColor: colors.bg,
    paddingTop: 14,
  },
});

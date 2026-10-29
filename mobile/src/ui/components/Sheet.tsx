import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Icon } from '../Icon';
import { colors, radius } from '../tokens';

// 底部弹层，对应原型 .modal-overlay + .sheet + .sheet-handle + .sheet-head。
// 遮罩点按、系统返回键、右上角关闭钮均可关闭；内容区可滚动（弹层内含输入框）。

export interface SheetProps {
  visible: boolean;
  title?: string;
  onClose: () => void;
  children: React.ReactNode;
}

export function Sheet({ visible, title, onClose, children }: SheetProps) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={onClose}>
      <View style={styles.overlay}>
        {/* 背板捕获层：独立于弹层之下，点遮罩关闭；不嵌套弹层内容，保证 ScrollView 手势灵敏 */}
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="关闭弹层" />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          {title != null && (
            <View style={styles.head}>
              <Text style={styles.headTitle}>{title}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="关闭弹层"
                hitSlop={8}
                onPress={onClose}>
                <Icon name="close" size={22} color={colors.ink} />
              </Pressable>
            </View>
          )}
          <ScrollView
            bounces={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.content}>
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    paddingHorizontal: 23,
    paddingTop: 10,
    maxHeight: '89%',
    // 原型 0 -15px 50px #1833221c
    shadowColor: '#183322',
    shadowOpacity: 0.11,
    shadowRadius: 50,
    shadowOffset: { width: 0, height: -15 },
    elevation: 24,
  },
  handle: {
    height: 4,
    width: 35,
    borderRadius: 4,
    backgroundColor: colors.sheetHandle,
    alignSelf: 'center',
    marginBottom: 13,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  headTitle: {
    fontSize: 21,
    fontWeight: '500',
    letterSpacing: -0.5,
    lineHeight: 30,
    color: colors.ink,
    flexShrink: 1,
  },
  content: {
    paddingBottom: 27,
  },
});

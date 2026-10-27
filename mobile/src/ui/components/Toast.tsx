import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radius } from '../tokens';

// 轻提示，对应原型 #toast：底部 94px（Tab 栏上方）、2600ms 自动消失、上移淡入 0.2s。
// M1 全局单条展示：新 toast 立即替换旧内容并重置计时。

const ToastContext = createContext<(message: string) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const anim = useRef(new Animated.Value(0)).current;
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();

  const show = useCallback((text: string) => {
    setMessage(text);
    setVisible(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setVisible(false), 2600);
  }, []);

  useEffect(() => {
    Animated.timing(anim, {
      toValue: visible ? 1 : 0,
      duration: 200,
      useNativeDriver: true,
    }).start();
  }, [visible, anim]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <Animated.View
        accessibilityLiveRegion="polite"
        pointerEvents="none"
        style={[
          styles.toast,
          {
            bottom: insets.bottom + 94,
            width: width - 44,
            opacity: anim,
            transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }],
          },
        ]}>
        {message ? <Text style={styles.text}>{message}</Text> : null}
      </Animated.View>
    </ToastContext.Provider>
  );
}

const styles = StyleSheet.create({
  toast: {
    position: 'absolute',
    alignSelf: 'center',
    paddingHorizontal: 15,
    paddingVertical: 12,
    backgroundColor: colors.toastBg,
    borderRadius: radius.buttonLg,
    zIndex: 30,
  },
  text: {
    color: colors.white,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
});

import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { useEffect, useRef } from 'react';
import { Icon, type IconName } from '../Icon';
import { Button } from './Button';
import { colors, radius, type } from '../tokens';

// 轻量展示组件集合，样式对应原型：.tag/.notice/.empty/.spinner/.loading/.demo-label。

export function Tag({ icon, label }: { icon?: IconName; label: string }) {
  return (
    <View style={styles.tag}>
      {icon ? <Icon name={icon} size={12} color={colors.tagText} /> : null}
      <Text style={styles.tagText}>{label}</Text>
    </View>
  );
}

export function Notice({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.notice}>
      <Text style={styles.noticeText}>{children}</Text>
    </View>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon: IconName;
  title: string;
  children: React.ReactNode;
  action?: { label: string; onPress: () => void };
}) {
  return (
    <View style={styles.empty}>
      <Icon name={icon} size={42} color={colors.emptyIcon} />
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyText}>{children}</Text>
      {action ? (
        <Button variant="primary" label={action.label} onPress={action.onPress} style={styles.emptyAction} />
      ) : null}
    </View>
  );
}

export function Spinner() {
  const rotate = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(rotate, { toValue: 1, duration: 1000, easing: Easing.linear, useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [rotate]);

  return (
    <Animated.View
      style={[
        styles.spinner,
        { transform: [{ rotate: rotate.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }] },
      ]}
    />
  );
}

export function LoadingBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.loading}>
      <Spinner />
      <Text style={styles.loadingTitle}>{title}</Text>
      <Text style={styles.loadingText}>{children}</Text>
    </View>
  );
}

/** 演示内容角标：叠加在演示图上，保证演示与真实资料不混淆（AGENTS 第 4 节规则 5） */
export function DemoLabel({ label }: { label: string }) {
  return (
    <View style={styles.demoLabel}>
      <Text style={styles.demoLabelText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    backgroundColor: colors.tagBg,
    borderRadius: 5,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  tagText: {
    color: colors.tagText,
    fontSize: 10,
    lineHeight: 14,
  },

  notice: {
    backgroundColor: colors.soft,
    borderRadius: radius.notice,
    paddingHorizontal: 13,
    paddingVertical: 12,
    marginVertical: 13,
  },
  noticeText: {
    color: colors.noticeText,
    fontSize: 11,
    lineHeight: 21,
  },

  empty: {
    alignItems: 'center',
    backgroundColor: colors.soft,
    borderRadius: radius.empty,
    paddingHorizontal: 18,
    paddingVertical: 40,
    marginTop: 22,
  },
  emptyTitle: {
    ...type.heading,
    color: colors.ink,
  },
  emptyText: {
    ...type.caption,
    color: colors.muted,
    textAlign: 'center',
    marginTop: 10,
    marginBottom: 20,
  },
  emptyAction: {
    alignSelf: 'stretch',
  },

  spinner: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 2,
    borderColor: colors.spinnerTrack,
    borderTopColor: colors.green,
    alignSelf: 'center',
    marginVertical: 25,
  },
  loading: {
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 45,
  },
  loadingTitle: {
    ...type.heading,
    color: colors.ink,
    marginBottom: 12,
  },
  loadingText: {
    ...type.caption,
    color: colors.muted,
    textAlign: 'center',
  },

  demoLabel: {
    position: 'absolute',
    top: 12,
    left: 12,
    backgroundColor: colors.demoLabelBg,
    borderRadius: 5,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  demoLabelText: {
    color: colors.demoLabelText,
    fontSize: 10,
    lineHeight: 14,
  },
});

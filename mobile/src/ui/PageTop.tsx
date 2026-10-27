import { StyleSheet, Text, View } from 'react-native';
import { Button } from './components/Button';
import { colors, type } from './tokens';

// 页头两种形态，对应原型 .page-top 与 .back-title。

export function PageTop({
  title,
  sub,
  eyebrow,
  right,
}: {
  title: string;
  sub?: string;
  /** 标题上方的眉题（原型 .hello） */
  eyebrow?: string;
  right?: React.ReactNode;
}) {
  return (
    <View style={styles.top}>
      <View style={styles.topTextWrap}>
        {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
        <Text style={[type.titleXL, styles.title]}>{title}</Text>
        {sub ? <Text style={styles.sub}>{sub}</Text> : null}
      </View>
      {right}
    </View>
  );
}

export function BackTitle({
  title,
  onBack,
  right,
}: {
  title: string;
  onBack: () => void;
  right?: React.ReactNode;
}) {
  return (
    <View style={styles.back}>
      <Button
        variant="round"
        roundSize={36}
        icon="back"
        accessibilityLabel="返回"
        onPress={onBack}
      />
      <Text style={[type.titleSm, styles.backTitleText]}>{title}</Text>
      {right}
    </View>
  );
}

const styles = StyleSheet.create({
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginVertical: 4,
    marginBottom: 22,
  },
  topTextWrap: {
    flexShrink: 1,
  },
  title: {
    color: colors.ink,
  },
  sub: {
    fontSize: 11,
    lineHeight: 16,
    color: colors.muted,
    marginTop: 5,
    letterSpacing: 1,
  },
  eyebrow: {
    fontSize: 12,
    lineHeight: 18,
    color: colors.muted,
    marginBottom: 7,
  },
  back: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 2,
    marginBottom: 18,
  },
  backTitleText: {
    color: colors.ink,
    flex: 1,
  },
});

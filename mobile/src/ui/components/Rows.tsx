import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon } from '../Icon';
import { colors } from '../tokens';

// 弹层内整行选项（.choice，含 selected 态）与设置页列表行（.setting-row）。

export function ChoiceRow({
  label,
  selected = false,
  onPress,
}: {
  label: string;
  selected?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.choice,
        selected && styles.choiceSelected,
        pressed && !selected && styles.choicePressed,
      ]}>
      <Text style={styles.choiceText}>{label}</Text>
      {selected ? <Icon name="check" size={18} color={colors.green} /> : null}
    </Pressable>
  );
}

export function SettingRow({
  icon,
  title,
  value,
  onPress,
}: {
  icon: Parameters<typeof Icon>[0]['name'];
  title: string;
  value: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
      <Icon name={icon} size={20} color={colors.ink} />
      <View style={styles.rowTextWrap}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.rowValue}>{value}</Text>
      </View>
      <Icon name="chevron" size={15} color={colors.ink} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  choice: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 11,
    marginVertical: 8,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    alignSelf: 'stretch',
  },
  choiceSelected: {
    borderColor: colors.choiceSelectedBorder,
    backgroundColor: colors.choiceSelectedBg,
  },
  choicePressed: {
    backgroundColor: colors.pressSoft,
  },
  choiceText: {
    color: colors.ink,
    fontSize: 13,
    lineHeight: 19,
    flexShrink: 1,
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    paddingVertical: 19,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  rowPressed: {
    opacity: 0.7,
  },
  rowTextWrap: {
    flex: 1,
  },
  rowTitle: {
    color: colors.ink,
    fontSize: 13,
    lineHeight: 19,
  },
  rowValue: {
    color: colors.muted,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 5,
  },
});

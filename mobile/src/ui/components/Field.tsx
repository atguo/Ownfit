import { StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import { Button } from './Button';
import { colors, radius } from '../tokens';

// 表单域，对应原型 .field（label + input）；原型下拉选择在 RN 中用胶囊选项行实现。

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

export function TextField(props: TextInputProps) {
  return (
    <TextInput
      placeholderTextColor={colors.muted}
      {...props}
      style={[styles.input, props.style]}
    />
  );
}

/** 胶囊选项行：单选，替代原型 <select> */
export function ChipSelect<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.chipRow}>
      {options.map((option) => (
        <Button
          key={option}
          variant="chip"
          label={option}
          active={option === value}
          onPress={() => onChange(option)}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  field: {
    marginVertical: 16,
  },
  fieldLabel: {
    color: colors.ink,
    fontSize: 12,
    lineHeight: 18,
  },
  input: {
    marginTop: 8,
    minHeight: 46,
    borderWidth: 1,
    borderColor: colors.inputBorder,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 13,
    backgroundColor: colors.white,
    color: colors.ink,
    fontSize: 14,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 8,
  },
});

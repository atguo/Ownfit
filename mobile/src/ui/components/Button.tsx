import { Pressable, StyleSheet, Text, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { Icon, type IconName } from '../Icon';
import { colors, radius } from '../tokens';

// 按钮变体与尺寸均对应原型 style.css：.primary/.secondary/.text-button/.small-button/.round-button/.chip/.segmented button。
// 原型禁用态 opacity .42；primary 按压色取原型 hover 值 #315c4d。

type ButtonVariant = 'primary' | 'secondary' | 'text' | 'small' | 'round' | 'chip' | 'segmented';


export interface ButtonProps {
  variant?: ButtonVariant;
  label?: string;
  icon?: IconName;
  /** chip/segmented 的选中态 */
  active?: boolean;
  /** small 变体的锁定态（#e3ebe0） */
  locked?: boolean;
  /** round 变体：36（返回行）或 42（页首，默认） */
  roundSize?: 36 | 42;
  /** round 变体的人名头像态（#e6ece1，衬线尺寸 19） */
  avatar?: boolean;
  /** secondary 变体的已收藏态（#e5eee1） */
  saved?: boolean;
  disabled?: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

export function Button({
  variant = 'primary',
  label,
  icon,
  active = false,
  locked = false,
  roundSize = 42,
  avatar = false,
  saved = false,
  disabled = false,
  onPress,
  accessibilityLabel,
  style,
}: ButtonProps) {
  if (variant === 'round') {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        disabled={disabled}
        onPress={onPress}
        style={({ pressed }) => [
          styles.round,
          roundSize === 36 && styles.roundSm,
          avatar && styles.roundAvatar,
          pressed && styles.pressed,
          style,
        ]}>
        {avatar && label ? (
          <Text style={styles.roundAvatarText}>{label}</Text>
        ) : (
          icon && <Icon name={icon} size={20} color={colors.ink} />
        )}
      </Pressable>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, selected: active }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        styles[variant],
        active && variant === 'chip' && styles.chipActive,
        variant === 'segmented' && active && styles.segmentedActive,
        locked && styles.smallLocked,
        saved && variant === 'secondary' && styles.secondarySaved,
        pressed && (variant === 'primary' ? styles.primaryPressed : styles.pressed),
        disabled && styles.disabled,
        style,
      ]}>
      {icon ? (
        <Icon
          name={icon}
          size={iconSizes[variant]}
          color={
            (active && variant === 'chip') || (variant === 'primary' && !locked)
              ? colors.white
              : variant === 'text'
                ? colors.green
                : colors.ink
          }
        />
      ) : null}
      {label ? (
        <Text
          style={[
            labelStyles[variant],
            active && variant === 'chip' && styles.chipActiveText,
            variant === 'segmented' && active && styles.segmentedActiveText,
            locked && styles.smallLockedText,
          ]}>
          {label}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: {
    opacity: 0.42,
  },
  pressed: {
    opacity: 0.75,
  },
  primaryPressed: {
    backgroundColor: colors.primaryPress,
  },

  primary: {
    backgroundColor: colors.green,
    minHeight: 49,
    borderRadius: radius.buttonLg,
    paddingHorizontal: 18,
    paddingVertical: 13,
    gap: 9,
    alignSelf: 'stretch',
  },
  primaryText: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '500',
  },

  secondary: {
    borderWidth: 1,
    borderColor: colors.secondaryBorder,
    backgroundColor: colors.white,
    minHeight: 46,
    paddingHorizontal: 15,
    paddingVertical: 12,
    borderRadius: radius.button,
    gap: 8,
  },
  secondaryText: {
    color: colors.ink,
    fontSize: 13,
  },
  secondarySaved: {
    backgroundColor: colors.savedSecondaryBg,
    borderColor: colors.savedSecondaryBg,
  },

  text: {
    minHeight: 36,
    paddingVertical: 6,
    gap: 6,
  },
  textText: {
    color: colors.green,
    fontSize: 12,
  },

  small: {
    backgroundColor: colors.soft,
    minHeight: 36,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: radius.small,
    gap: 5,
  },
  smallText: {
    color: colors.ink,
    fontSize: 11,
  },
  smallLocked: {
    backgroundColor: colors.lockedBtnBg,
  },
  smallLockedText: {
    color: colors.lockedBtnText,
  },

  round: {
    width: 42,
    height: 42,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.white,
  },
  roundSm: {
    width: 36,
    height: 36,
    borderWidth: 0,
    backgroundColor: 'transparent',
  },
  roundAvatar: {
    backgroundColor: colors.avatarBg,
    borderColor: colors.avatarBg,
  },
  roundAvatarText: {
    color: colors.avatarText,
    fontSize: 19,
    fontFamily: 'serif',
  },

  chip: {
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.white,
    minHeight: 37,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: radius.pill,
  },
  chipText: {
    color: colors.ink,
    fontSize: 12,
  },
  chipActive: {
    backgroundColor: colors.green,
    borderColor: colors.green,
  },
  chipActiveText: {
    color: colors.white,
  },

  segmented: {
    flex: 1,
    minHeight: 36,
    paddingVertical: 9,
    paddingHorizontal: 5,
    borderRadius: radius.small,
  },
  segmentedActive: {
    backgroundColor: colors.white,
    // 原型 0 2px 6px #20302009
    shadowColor: '#203020',
    shadowOpacity: 0.035,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  segmentedText: {
    color: colors.ink,
    fontSize: 12,
  },
  segmentedActiveText: {
    color: colors.green,
  },
});

const labelStyles: Record<ButtonVariant, TextStyle> = {
  primary: styles.primaryText,
  secondary: styles.secondaryText,
  text: styles.textText,
  small: styles.smallText,
  round: styles.roundAvatarText,
  chip: styles.chipText,
  segmented: styles.segmentedText,
};

const iconSizes: Record<ButtonVariant, number> = {
  primary: 18,
  secondary: 16,
  text: 14,
  small: 14,
  round: 20,
  chip: 16,
  segmented: 16,
};

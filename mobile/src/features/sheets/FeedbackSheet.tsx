// 记录穿着感受（原型 feedback/feedback-save，M3 真实版写入 worn_records）：
// 满意与不满意分别记录；"先只记录穿过"是跳过态——只记穿过、保留未知，不视为满意。

import { StyleSheet, Text } from 'react-native';
import { Sheet } from '../../ui/components/Sheet';
import { ChoiceRow } from '../../ui/components/Rows';
import { Button } from '../../ui/components/Button';
import { useToast } from '../../ui/components/Toast';
import { colors, type } from '../../ui/tokens';
import { recordWorn } from '../../data/repositories/planRepository';

export function FeedbackSheet({
  planId,
  onClose,
}: {
  planId: string | null;
  onClose: () => void;
}) {
  const toast = useToast();

  function record(value: 'happy' | 'unhappy' | 'skip') {
    if (planId) recordWorn(planId, value);
    onClose();
    toast(
      value === 'happy'
        ? '已记录：穿过且满意'
        : value === 'skip'
          ? '已记录穿过，满意情况仍未知'
          : '已记录穿着感受',
    );
  }

  return (
    <Sheet visible={planId != null} title="今天穿了，感觉如何？" onClose={onClose}>
      <Text style={styles.description}>选一个感受就好，也可以先只记录穿过。</Text>
      <ChoiceRow label="舒服，也喜欢" onPress={() => record('happy')} />
      <ChoiceRow label="有一点不合适" onPress={() => record('unhappy')} />
      <Button variant="text" label="先只记录穿过" onPress={() => record('skip')} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  description: {
    ...type.caption,
    color: colors.muted,
    lineHeight: 23,
    marginBottom: 15,
  },
});

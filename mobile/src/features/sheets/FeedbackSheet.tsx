// 记录穿着感受（原型 feedback/feedback-save，M3 真实版写入 worn_records）：
// 满意与不满意分别记录；"先只记录穿过"是跳过态——只记穿过、保留未知，不视为满意。
// D1（2026-11-04）：先等落库成功再提示成功——失败保留用户选择与弹层，不静默丢证据。
// D3（2026-11-04 提前实现）：满意/不满意后提供少量可跳过原因（多选、默认不填），
// 关联方案版本；用于区分"看着不喜欢/穿着不舒服/冷热不合适/预览不像实物"，
// 不把换掉一件等同于永久不喜欢，也不把整套感受自动归因到每件衣服。

import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Sheet } from '../../ui/components/Sheet';
import { ChoiceRow } from '../../ui/components/Rows';
import { Button } from '../../ui/components/Button';
import { Notice } from '../../ui/components/Basics';
import { useToast } from '../../ui/components/Toast';
import { colors, type } from '../../ui/tokens';
import { recordWorn } from '../../data/repositories/planRepository';

/** 最小原因清单（建议稿 D3）：可多选、可全部不选；不区分单件归因 */
const FEEDBACK_REASONS = ['看着不喜欢', '穿着不舒服', '冷热不合适', '预览不像实物'] as const;

type Feeling = 'happy' | 'unhappy' | 'skip';

export function FeedbackSheet({
  planId,
  onClose,
}: {
  planId: string | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const [feeling, setFeeling] = useState<Feeling | null>(null);
  const [reasons, setReasons] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  function chooseFeeling(value: Feeling) {
    // "先只记录穿过"无原因可填，直接进入保存
    if (value === 'skip') {
      setFeeling('skip');
      void save('skip', []);
      return;
    }
    setFeeling(value);
    setReasons([]);
  }

  function toggleReason(reason: string) {
    setReasons((current) =>
      current.includes(reason) ? current.filter((r) => r !== reason) : [...current, reason],
    );
  }

  async function save(value: Feeling, withReasons: string[]) {
    if (!planId || saving) return;
    setSaving(true);
    try {
      // D1：等待落库成功才提示；失败保留弹层与选择，防止实际证据静默丢失
      await recordWorn(planId, value, undefined, withReasons);
      const reasonSuffix = withReasons.length ? `（原因：${withReasons.join('、')}）` : '';
      onClose();
      toast(
        value === 'happy'
          ? `已记录：穿过且满意${reasonSuffix}`
          : value === 'skip'
            ? '已记录穿过，满意情况仍未知'
            : `已记录穿着感受${reasonSuffix}`,
      );
    } catch (error) {
      toast(`记录失败，你的选择已保留，请重试：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet visible={planId != null} title="今天穿了，感觉如何？" onClose={onClose}>
      <Text style={styles.description}>选一个感受就好，也可以先只记录穿过。</Text>

      {feeling === null || feeling === 'skip' ? (
        <View>
          <ChoiceRow label="舒服，也喜欢" onPress={() => chooseFeeling('happy')} />
          <ChoiceRow label="有一点不合适" onPress={() => chooseFeeling('unhappy')} />
          <Button variant="text" label="先只记录穿过" onPress={() => chooseFeeling('skip')} />
        </View>
      ) : (
        <View>
          <Notice>{feeling === 'happy' ? '记为：舒服，也喜欢' : '记为：有一点不合适'}</Notice>
          <Text style={styles.reasonTitle}>为什么？（可多选，也可以不填）</Text>
          <View style={styles.reasonRow}>
            {FEEDBACK_REASONS.map((reason) => (
              <Button
                key={reason}
                variant="chip"
                label={reason}
                active={reasons.includes(reason)}
                onPress={() => toggleReason(reason)}
              />
            ))}
          </View>
          <Button
            variant="primary"
            label={saving ? '正在保存…' : '保存记录'}
            onPress={() => void save(feeling, reasons)}
            disabled={saving}
          />
          <Button
            variant="text"
            label="跳过原因，直接保存"
            onPress={() => void save(feeling, [])}
            disabled={saving}
          />
          <Button variant="text" label="返回重选" onPress={() => setFeeling(null)} disabled={saving} />
        </View>
      )}
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
  reasonTitle: {
    ...type.footnote,
    color: colors.ink,
    marginVertical: 8,
  },
  reasonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 10,
  },
});

// 真实单品详情与编辑（M2）：展示 + 编辑名称/品类 + 入库/归档/恢复/彻底删除。
// 规则依据衣橱功能文档：未知显式表达（颜色/尺寸未知不冒充）；彻底删除需二次确认（UI 负责）。

import { useEffect, useState } from 'react';
import { Alert, Image, StyleSheet, Text, View } from 'react-native';
import { Sheet } from '../../ui/components/Sheet';
import { Button } from '../../ui/components/Button';
import { Field, TextField } from '../../ui/components/Field';
import { useToast } from '../../ui/components/Toast';

/** 详情两列键值格（原 DemoSheet 的 DetailCell，随 M3 迁入） */
function DetailCell({ label, value }: { label: string; value: string }) {
  return (
    <View>
      <Text style={styles.cellLabel}>{label}</Text>
      <Text style={styles.cellValue}>{value}</Text>
    </View>
  );
}
import {
  archiveItem,
  confirmItem,
  purgeItem,
  restoreItem,
  updateItemBasics,
  type WardrobeItem,
} from '../../data/repositories/itemRepository';
import { categories, type ItemCategory } from '../../data/demo';
import { colors, radius, type } from '../../ui/tokens';

export interface WardrobeItemDetail {
  item: WardrobeItem;
  /** 详情展示用原图 */
  originalUri: string | null;
}

export function WardrobeItemSheet({
  detail,
  onClose,
  onChanged,
  onUse,
}: {
  detail: WardrobeItemDetail | null;
  onClose: () => void;
  /** 条目发生变化（入库/编辑/归档/删除）后回调，列表刷新 */
  onChanged: () => void;
  /** 已入库单品：围绕这件搭配（进入搭配会话） */
  onUse: (id: string) => void;
}) {
  const toast = useToast();
  const item = detail?.item;
  const [name, setName] = useState('');
  const [category, setCategory] = useState<ItemCategory | undefined>();

  // 每次打开时按当前条目回填
  useEffect(() => {
    if (item) {
      setName(item.name ?? '');
      setCategory(item.category ?? undefined);
    }
  }, [item?.id, item?.updatedAt]);

  async function saveBasics() {
    if (!item) return;
    await updateItemBasics(item.id, { name, category: category ?? undefined });
    onChanged();
    toast('已保存');
  }

  async function confirmDraft() {
    if (!item || !category) {
      toast('请先选择品类');
      return;
    }
    await confirmItem(item.id, { category, name });
    onChanged();
    onClose();
    toast('已入库，尺寸和细节以后再补');
  }

  async function archive() {
    if (!item) return;
    await archiveItem(item.id);
    onChanged();
    onClose();
    toast('已归档，可在衣橱“已归档”里找回');
  }

  async function restore() {
    if (!item) return;
    await restoreItem(item.id);
    onChanged();
    onClose();
    toast('已恢复到衣橱');
  }

  function purge() {
    if (!item) return;
    const label = item.name ?? '这件衣服';
    Alert.alert('彻底删除？', `“${label}” 及其照片将从本机永久删除，无法恢复（没有云端备份）。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '彻底删除',
        style: 'destructive',
        onPress: async () => {
          await purgeItem(item.id);
          onChanged();
          onClose();
          toast('已彻底删除');
        },
      },
    ]);
  }

  const isDraft = item?.status === 'draft';
  const isArchived = item?.status === 'archived';

  return (
    <Sheet visible={item != null} title={item?.name ?? '单品详情'} onClose={onClose}>
      {item ? (
        <>
          {isDraft ? <Text style={styles.statusNote}>草稿 · 确认品类后入库</Text> : null}
          {isArchived ? <Text style={styles.statusNote}>已归档 · 不出现在衣橱列表</Text> : null}

          {detail?.originalUri ? (
            <Image
              source={{ uri: detail.originalUri }}
              style={styles.photo}
              resizeMode="cover"
              accessibilityLabel={item.name ?? '单品照片'}
            />
          ) : null}

          <Field label="名称（可选）">
            <TextField value={name} onChangeText={setName} maxLength={30} placeholder="给它一个名字" />
          </Field>

          <Field label="品类（必选）">
            <View style={styles.chipRow}>
              {categories.map((option) => (
                <Button
                  key={option}
                  variant="chip"
                  label={option}
                  active={category === option}
                  onPress={() => setCategory(option)}
                />
              ))}
            </View>
          </Field>

          <View style={styles.detailList}>
            <DetailCell label="颜色" value="未知（可稍后补充）" />
            <DetailCell label="来源" value="你拍摄/选择的照片" />
            <DetailCell label="实测尺寸" value="未填写" />
          </View>

          <Text style={styles.description}>
            需要判断衣长或松紧时，再补相关尺寸。现在也可以先看看怎么搭。
          </Text>

          {isDraft ? (
            <Button variant="primary" label="确认入库" onPress={confirmDraft} />
          ) : (
            <>
              <Button variant="primary" label="围绕这件搭配" onPress={() => item && onUse(item.id)} />
              <Button variant="secondary" label="保存修改" onPress={saveBasics} style={styles.gap} />
            </>
          )}

          {isDraft ? null : isArchived ? (
            <Button variant="secondary" label="恢复到衣橱" onPress={restore} style={styles.gap} />
          ) : (
            <Button variant="secondary" label="归档（可恢复）" onPress={archive} style={styles.gap} />
          )}
          <Button variant="text" label="彻底删除…" onPress={purge} />
        </>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  cellLabel: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 5,
  },
  cellValue: {
    color: colors.ink,
    fontSize: 12,
    lineHeight: 18,
  },
  photo: {
    width: 150,
    height: 150,
    alignSelf: 'center',
    marginTop: 10,
    marginBottom: 16,
    borderRadius: radius.buttonLg,
    backgroundColor: colors.artBg,
  },
  statusNote: {
    fontSize: 12,
    lineHeight: 18,
    color: colors.muted,
    marginBottom: 10,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 8,
  },
  detailList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 14,
    marginVertical: 17,
  },
  description: {
    ...type.caption,
    color: colors.muted,
    lineHeight: 23,
    marginBottom: 15,
  },
  gap: {
    alignSelf: 'stretch',
    marginTop: 10,
  },
});

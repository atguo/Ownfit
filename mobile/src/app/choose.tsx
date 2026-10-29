import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Page } from '../ui/Screen';
import { BackTitle } from '../ui/PageTop';
import { Pressable } from 'react-native';
import { Button } from '../ui/components/Button';
import { Notice, Tag } from '../ui/components/Basics';
import { ItemArt } from '../ui/components/ItemArt';
import { buildOutfit, setSelect, useDemoStore } from '../features/demoStore';
import { colors, type } from '../ui/tokens';

// 选择基础单品（原型 choose()）：选中一件 → 搭配这件；空衣橱时引导去添加。
export default function ChooseScreen() {
  const router = useRouter();
  const { items, newUser, select } = useDemoStore();

  const list = newUser ? items.filter((i) => i.color === '尚未确认') : items;

  return (
    <Page
      footer={
        <>
          <Button
            variant="primary"
            label={list.length ? '搭配这件衣服' : '添加第一件'}
            onPress={() => {
              if (list.length) {
                if (buildOutfit(select)) router.push('/outfit');
              } else {
                router.push('/add');
              }
            }}
          />
          <Text style={styles.underNote}>选中的单品会保持锁定</Text>
        </>
      }>
      <BackTitle title="从哪一件开始？" onBack={() => router.back()} />
      <Tag icon="info" label="演示数据 · 真实衣橱在“衣橱”页" />
      <View style={styles.tagGap} />
      <Text style={[type.titleXL, styles.title]}>今天，想穿这件。</Text>
      <Text style={styles.subtitle}>选中一件喜欢的，其他的交给搭配。</Text>

      {list.length > 0 ? (
        <View style={styles.grid}>
          {list.map((item) => {
            const selected = select === item.id;
            return (
              <Pressable
                key={item.id}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={item.name}
                onPress={() => setSelect(item.id)}
                style={[styles.cell, selected && styles.cellSelected]}>
                <ItemArt x={item.x} y={item.y} radius={13} />
                <Text style={styles.cellName}>{item.name}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : (
        <Notice>还没有录入衣服，先添加一件就好。</Notice>
      )}
    </Page>
  );
}

const styles = StyleSheet.create({
  tagGap: {
    height: 13,
  },
  title: {
    color: colors.ink,
  },
  subtitle: {
    fontSize: 12,
    lineHeight: 19,
    color: colors.muted,
    marginTop: 6,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginVertical: 18,
  },
  cell: {
    width: '47.5%',
    borderWidth: 2,
    borderColor: 'transparent',
    borderRadius: 15,
    padding: 5,
  },
  cellSelected: {
    borderColor: colors.green,
  },
  cellName: {
    color: colors.ink,
    fontSize: 12,
    fontWeight: '500',
    lineHeight: 18,
    marginTop: 9,
    marginBottom: 5,
  },
  underNote: {
    textAlign: 'center',
    fontSize: 10,
    lineHeight: 14,
    color: colors.muted,
    marginTop: 9,
  },
});

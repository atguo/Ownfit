import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Asset } from 'expo-asset';
import { Page } from '../../ui/Screen';
import { BackTitle } from '../../ui/PageTop';
import { Button } from '../../ui/components/Button';
import {
  DemoLabel,
  EmptyState,
  LoadingBlock,
  Notice,
  Spinner,
  Tag,
} from '../../ui/components/Basics';
import { ChoiceRow, SettingRow } from '../../ui/components/Rows';
import { ItemArt, LookArt } from '../../ui/components/ItemArt';
import { OutfitBoard } from '../../ui/components/OutfitBoard';
import { ChipSelect, Field, TextField } from '../../ui/components/Field';
import { useToast } from '../../ui/components/Toast';
import { resetDemo, useDemoStore } from '../../features/demoStore';
import { createDraftFromPhoto, confirmItem } from '../../data/repositories/itemRepository';
import { categories } from '../../data/demo';
import { colors, pagePadding, radius, type } from '../../ui/tokens';

// 组件展示（M1 交付物）：设计令牌、组件与状态一屏陈列，并挂接演示数据切换（空衣橱态等）。
// 仅开发用入口，从“我的”页进入。
export default function ComponentsScreen() {
  const router = useRouter();
  const toast = useToast();
  const store = useDemoStore();
  const [chip, setChip] = useState<'今天' | '明天'>('今天');
  const [choice, setChoice] = useState('自然垂放');
  const [input, setInput] = useState('');

  return (
    <Page>
      <BackTitle title="组件展示" onBack={() => router.back()} />

      <Section title="颜色令牌（prototype/style.css :root + 派生）">
        <View style={styles.swatchWrap}>
          {(
            [
              ['bg', colors.bg],
              ['soft', colors.soft],
              ['ink', colors.ink],
              ['green', colors.green],
              ['muted', colors.muted],
              ['line', colors.line],
              ['accent', colors.accent],
            ] as const
          ).map(([name, value]) => (
            <View key={name} style={styles.swatch}>
              <View style={[styles.swatchColor, { backgroundColor: value, borderColor: colors.line }]} />
              <Text style={styles.swatchLabel}>{name}</Text>
              <Text style={styles.swatchValue}>{value}</Text>
            </View>
          ))}
        </View>
      </Section>

      <Section title="字阶">
        <Text style={[type.titleXL, styles.ink]}>大标题 27/500</Text>
        <Text style={[type.titleMd, styles.ink]}>弹层标题 21/500</Text>
        <Text style={[type.heading, styles.ink]}>小标题 17/600</Text>
        <Text style={[type.body, styles.ink]}>正文 14</Text>
        <Text style={[type.caption, styles.ink]}>辅助 12</Text>
        <Text style={[type.micro, styles.ink]}>角标 10</Text>
      </Section>

      <Section title="按钮（原型各变体）">
        <Button variant="primary" label="主按钮" onPress={() => toast('primary 按下')} />
        <Button variant="primary" label="主按钮禁用" disabled style={styles.gap} />
        <Button variant="secondary" label="次按钮" style={styles.gap} />
        <Button variant="secondary" label="次按钮 · 已收藏" saved style={styles.gap} />
        <Button variant="text" label="文字按钮" style={styles.gap} />
        <View style={styles.row}>
          <Button variant="small" icon="unlock" label="换一件" />
          <Button variant="small" icon="lock" locked label="已锁定" />
        </View>
      </Section>

      <Section title="筛选与分段">
        <View style={styles.row}>
          <Button variant="chip" label="全部" active />
          <Button variant="chip" label="上衣" />
        </View>
        <View style={styles.segmentedWrap}>
          <Button variant="segmented" label="单套查看" active />
          <Button variant="segmented" label="两套比较" />
        </View>
      </Section>

      <Section title="单品图（wardrobe.png 雪碧图 6 格）">
        <View style={styles.artGrid}>
          {(
            [
              [0, 0],
              [50, 0],
              [100, 0],
              [0, 100],
              [50, 100],
              [100, 100],
            ] as const
          ).map(([x, y]) => (
            <View key={`${x}-${y}`} style={styles.artGridChild}>
              <ItemArt x={x} y={y} radius={15} />
            </View>
          ))}
        </View>
      </Section>

      <Section title="模特图（looks.png 2 格）与演示角标">
        <View style={styles.lookRow}>
          <View style={styles.lookCell}>
            <LookArt look={0} style={styles.lookArt} />
            <DemoLabel label="示例 A" />
          </View>
          <View style={styles.lookCell}>
            <LookArt look={1} style={styles.lookArt} />
            <DemoLabel label="示例 B" />
          </View>
        </View>
      </Section>

      <Section title="搭配板">
        <OutfitBoard topId={store.top} lockLabel="炭灰色阔腿裤" />
      </Section>

      <Section title="标签 · 提示块 · 轻提示">
        <View style={styles.row}>
          <Tag icon="closet" label="来自你的衣橱" />
          <Tag label="可以用于基础搭配" />
        </View>
        <Notice>提示块：天气为固定演示值 18–24℃，不随地点改变，也不是实时预报。</Notice>
        <Button variant="secondary" label="触发 Toast（2600ms）" onPress={() => toast('这是一条轻提示')} />
      </Section>

      <Section title="弹层选项与设置行">
        <ChoiceRow label="自然垂放" selected={choice === '自然垂放'} onPress={() => setChoice('自然垂放')} />
        <ChoiceRow label="前侧塞衣角" selected={choice === '前侧塞衣角'} onPress={() => setChoice('前侧塞衣角')} />
        <SettingRow icon="heart" title="穿衣偏好" value="简约日常、宽松一些" onPress={() => {}} />
      </Section>

      <Section title="输入域">
        <Field label="给它一个名字">
          <TextField value={input} onChangeText={setInput} placeholder="键盘弹出时不遮挡主操作" />
        </Field>
        <ChipSelect options={['今天', '明天'] as const} value={chip} onChange={setChip} />
      </Section>

      <Section title="加载与空状态">
        <Spinner />
        <LoadingBlock title="让搭配更直观一点。">正在模拟生成等待状态，未调用 AI 服务。</LoadingBlock>
        <EmptyState icon="closet" title="一件，就是好的开始。">
          {'先添加今天想穿的衣服，\n不需要一次整理整个衣橱。'}
        </EmptyState>
      </Section>

      <Section title="演示数据开关">
        <Button
          variant="secondary"
          label={store.newUser ? '切回初始示例（有 6 件单品）' : '体验首次空衣橱（newUser）'}
          onPress={() => resetDemo(store.newUser ? 'default' : 'newUser')}
        />
        <Text style={styles.hint}>
          {'切到空衣橱后，首页显示引导卡、衣橱/选择页显示空态。\n页面内边距 '}
          {pagePadding.x}
          {'dp，圆角基准 '}
          {radius.base}
          {'dp。'}
        </Text>
      </Section>

      <Section title="性能验证（M2 验收：大量图片浏览）">
        <Button
          variant="secondary"
          label="批量生成 30 件种子单品（写入真实数据库）"
          onPress={async () => {
            toast('开始生成种子数据…');
            try {
              const asset = Asset.fromModule(require('../../assets/demo/wardrobe.png'));
              if (!asset.downloaded) await asset.downloadAsync();
              const uri = asset.localUri ?? asset.uri;
              for (let i = 0; i < 30; i += 1) {
                const item = await createDraftFromPhoto(uri, `seed-${Date.now().toString(36)}-${i}`);
                await confirmItem(item.id, {
                  category: categories[i % categories.length],
                  name: `种子单品 ${i + 1}`,
                });
              }
              toast('已生成 30 件种子单品，去“衣橱”页验证滚动');
            } catch (error) {
              toast(`种子生成失败：${error instanceof Error ? error.message : String(error)}`);
            }
          }}
        />
        <Text style={styles.hint}>写入的是真实数据库（用于大量图片滚动与重启恢复验证），与演示开关互不影响。</Text>
      </Section>
    </Page>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  ink: {
    color: colors.ink,
  },
  section: {
    marginBottom: 28,
  },
  sectionTitle: {
    ...type.heading,
    color: colors.muted,
    marginBottom: 12,
  },
  swatchWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  swatch: {
    width: 84,
  },
  swatchColor: {
    height: 44,
    borderRadius: 10,
    borderWidth: 1,
  },
  swatchLabel: {
    ...type.caption,
    color: colors.ink,
    marginTop: 6,
  },
  swatchValue: {
    ...type.micro,
    color: colors.muted,
  },
  gap: {
    marginTop: 10,
  },
  row: {
    flexDirection: 'row',
    gap: 9,
    marginTop: 10,
  },
  segmentedWrap: {
    backgroundColor: colors.soft,
    borderRadius: radius.button,
    padding: 4,
    flexDirection: 'row',
    marginTop: 12,
  },
  artGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  artGridChild: {
    width: '30%',
  },
  lookRow: {
    flexDirection: 'row',
    gap: 12,
  },
  lookCell: {
    flex: 1,
    height: 220,
    borderRadius: radius.empty,
    overflow: 'hidden',
    backgroundColor: colors.heroArtBg,
  },
  lookArt: {
    flex: 1,
  },
  hint: {
    ...type.footnote,
    color: colors.muted,
    marginTop: 10,
    lineHeight: 20,
  },
});

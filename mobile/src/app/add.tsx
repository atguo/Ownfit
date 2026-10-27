import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Page } from '../ui/Screen';
import { BackTitle } from '../ui/PageTop';
import { Button } from '../ui/components/Button';
import { Notice } from '../ui/components/Basics';
import { ItemArt } from '../ui/components/ItemArt';
import { ChipSelect, Field, TextField } from '../ui/components/Field';
import { useToast } from '../ui/components/Toast';
import { Icon } from '../ui/Icon';
import { addItem } from '../features/demoStore';
import { categories, type ItemCategory } from '../data/demo';
import { colors, radius, type } from '../ui/tokens';

// 添加一件衣服（原型 add()）：轻量入库界面。M1 仅演示流程——相机/相册接入属 M2，
// “拍照或从相册选择”以示例体验代替；名称校验与入库提示与原型一致。
export default function AddScreen() {
  const router = useRouter();
  const toast = useToast();
  const [draft, setDraft] = useState<{ name: string; cat: ItemCategory } | null>(null);
  const [name, setName] = useState('');

  function save() {
    if (!name.trim()) {
      toast('请给这件衣服一个名字');
      return;
    }
    if (draft) {
      addItem({ name: name.trim(), cat: draft.cat });
    }
    setDraft(null);
    router.back();
    toast('已入库，尺寸和细节以后再补');
  }

  return (
    <Page>
      <BackTitle title="添加一件衣服" onBack={() => router.back()} />
      <Text style={styles.stepTop}>先有照片，其他慢慢来。</Text>
      <Text style={[type.titleXL, styles.title]}>从这一件开始。</Text>
      <Text style={styles.subtitle}>不用找尺子，也不用填写一整张表。</Text>

      {draft ? (
        <>
          <View style={styles.uploadPreview}>
            <ItemArt x={0} y={100} radius={13} label="示例照片" />
          </View>
          <Field label="给它一个名字">
            <TextField
              value={name}
              maxLength={30}
              onChangeText={setName}
              placeholder="例如：浅蓝色棉衬衫"
              autoFocus
            />
          </Field>
          <Field label="确认品类">
            <ChipSelect options={categories} value={draft.cat} onChange={(cat) => setDraft({ ...draft, cat })} />
          </Field>
          <Notice>确认照片里是哪一件衣服即可。尺寸、面料和体感都可以以后再补。</Notice>
          <Button variant="primary" label="保存到衣橱" onPress={save} />
          <Button variant="text" label="重新选择照片" onPress={() => setDraft(null)} />
        </>
      ) : (
        <>
          <Pressable
            accessibilityRole="button"
            onPress={() => toast('相机与相册将在 M2 接入，先用示例体验')}
            style={({ pressed }) => [styles.upload, pressed && styles.pressed]}>
            <Icon name="camera" size={29} color={colors.uploadIcon} />
            <Text style={styles.uploadTitle}>拍照或从相册选择</Text>
            <Text style={styles.uploadHint}>拍清衣服整体，一张就可以</Text>
          </Pressable>
          <Button
            variant="secondary"
            label="先用示例体验"
            onPress={() => {
              setDraft({ name: '浅蓝色棉衬衫', cat: '上衣' });
              setName('浅蓝色棉衬衫');
            }}
            style={styles.full}
          />
          <Text style={styles.subtleInfo}>
            {'照片仅保存在本机，不会上传。\n演示版不自动识别品类，请手动确认。'}
          </Text>
        </>
      )}
    </Page>
  );
}

const styles = StyleSheet.create({
  stepTop: {
    ...type.footnote,
    color: colors.muted,
    marginTop: 17,
    marginBottom: 0,
  },
  title: {
    color: colors.ink,
    marginTop: 8,
  },
  subtitle: {
    fontSize: 12,
    lineHeight: 19,
    color: colors.muted,
    marginTop: 6,
  },
  upload: {
    height: 190,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.uploadBorder,
    backgroundColor: colors.soft,
    borderRadius: radius.empty,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
    marginVertical: 20,
    alignSelf: 'stretch',
  },
  pressed: {
    opacity: 0.8,
  },
  uploadIcon: {
    marginBottom: 0,
  },
  uploadTitle: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '500',
  },
  uploadHint: {
    fontSize: 11,
    lineHeight: 16,
    color: colors.muted,
  },
  uploadPreview: {
    width: 185,
    height: 185,
    alignSelf: 'center',
    marginTop: 15,
    marginBottom: 15,
  },
  full: {
    alignSelf: 'stretch',
  },
  subtleInfo: {
    ...type.footnote,
    lineHeight: 20,
    color: colors.subtleInfo,
    marginTop: 15,
    textAlign: 'center',
  },
});

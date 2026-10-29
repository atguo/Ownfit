import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { Page } from '../../ui/Screen';
import { PageTop } from '../../ui/PageTop';
import { SettingRow } from '../../ui/components/Rows';
import {
  BodySheet,
  PreferencesSheet,
  PrivacySheet,
  ReferenceSheet,
  ResetSheet,
} from '../../features/sheets/ProfileSheets';
import { setPrefs, useDemoStore } from '../../features/demoStore';
import { getPreferences } from '../../data/repositories/settingsRepository';
import { colors, radius, type } from '../../ui/tokens';

type SheetName = 'prefs' | 'reference' | 'body' | 'privacy' | 'reset' | null;

// 我的（原型 profile()）：头像区、长期偏好说明、设置行。
// 长期偏好与当次意图分开呈现；页面另设开发区入口（组件展示，仅 M1 开发用）。
export default function ProfileScreen() {
  const router = useRouter();
  const { prefs, reference } = useDemoStore();
  const [sheet, setSheet] = useState<SheetName>(null);

  // M2：偏好来自本地数据库；人物参考仍是演示状态（M5 接真实参考）
  useFocusEffect(
    useCallback(() => {
      void getPreferences().then(setPrefs);
    }, []),
  );

  return (
    <Page>
      <PageTop title="我的" />

      <View style={styles.head}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>林</Text>
        </View>
        <View style={styles.headText}>
          <Text style={styles.headTitle}>做自在的自己。</Text>
          <Text style={styles.headSub}>个人资料按需要补充就好</Text>
        </View>
      </View>

      <View style={styles.note}>
        <Text style={styles.noteTitle}>先懂你的喜欢。</Text>
        <Text style={styles.noteText}>
          今天的心情可以不同。临时想穿正式一点，不会改变你的长期偏好。
        </Text>
      </View>

      <SettingRow
        icon="heart"
        title="穿衣偏好"
        value={prefs.length ? prefs.join('、') : '未设置'}
        onPress={() => setSheet('prefs')}
      />
      <SettingRow
        icon="user"
        title="人物参考"
        value={reference ? '使用演示参考' : '尚未准备'}
        onPress={() => setSheet('reference')}
      />
      <SettingRow icon="grid" title="身材资料" value="按需补充" onPress={() => setSheet('body')} />
      <SettingRow icon="lock" title="照片与隐私" value="仅本地演示" onPress={() => setSheet('privacy')} />
      <SettingRow
        icon="spark"
        title="模型配置"
        value="AI 服务连接"
        onPress={() => router.push('/ai/config')}
      />

      {/* M1 开发入口：交付物“组件展示” */}
      <SettingRow
        icon="grid"
        title="组件展示（开发）"
        value="M1 组件与状态一览"
        onPress={() => router.push('/dev/components')}
      />

      <Text style={styles.subtleInfo}>
        {'本演示版不上传照片，不接入账号或模型服务。\n演示内容只保存在本次运行中。'}
      </Text>

      <PreferencesSheet visible={sheet === 'prefs'} onClose={() => setSheet(null)} />
      <ReferenceSheet visible={sheet === 'reference'} onClose={() => setSheet(null)} />
      <BodySheet visible={sheet === 'body'} onClose={() => setSheet(null)} />
      <PrivacySheet
        visible={sheet === 'privacy'}
        onClose={() => setSheet(null)}
        onManageDemo={() => setSheet('reset')}
      />
      <ResetSheet visible={sheet === 'reset'} onClose={() => setSheet(null)} />
    </Page>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 15,
    marginTop: 18,
    marginBottom: 25,
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.profileAvatarBg,
  },
  avatarText: {
    fontSize: 25,
    lineHeight: 32,
    color: colors.profileAvatarText,
    fontFamily: 'serif',
  },
  headText: {
    flexShrink: 1,
  },
  headTitle: {
    ...type.titleXL,
    fontSize: 23,
    lineHeight: 33,
    color: colors.ink,
  },
  headSub: {
    ...type.footnote,
    color: colors.muted,
  },
  note: {
    backgroundColor: colors.profileNoteBg,
    borderRadius: 16,
    padding: 18,
    marginVertical: 22,
  },
  noteTitle: {
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 20,
    color: colors.ink,
    marginBottom: 7,
  },
  noteText: {
    ...type.footnote,
    color: colors.muted,
  },
  subtleInfo: {
    ...type.footnote,
    lineHeight: 20,
    color: colors.subtleInfo,
    marginTop: 15,
  },
});

import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Page } from '../../ui/Screen';
import { PageTop } from '../../ui/PageTop';
import { Button } from '../../ui/components/Button';
import { Icon } from '../../ui/Icon';
import { ItemArt, LookArt } from '../../ui/components/ItemArt';
import { Tag } from '../../ui/components/Basics';
import { SceneSheet } from '../../features/sheets/SceneSheet';
import { setContext, useDemoStore } from '../../features/demoStore';
import { getSceneDefault } from '../../data/repositories/settingsRepository';
import { colors, radius, type } from '../../ui/tokens';

const weekdays = ['日', '一', '二', '三', '四', '五', '六'];

// 今天（原型 home()）：日期眉题、天气条（固定演示值）、hero 或新用户引导、衣橱速览。
export default function TodayScreen() {
  const router = useRouter();
  const { newUser, context } = useDemoStore();
  const [sceneOpen, setSceneOpen] = useState(false);
  const now = new Date();
  const dateLine = `${now.getMonth() + 1}月${now.getDate()}日，星期${weekdays[now.getDay()]}`;

  // M2：常用场景默认值从本地数据库回填（天气文档 §4.1：默认值可见且可修改）
  useEffect(() => {
    void getSceneDefault().then((saved) => {
      if (saved) setContext(saved);
    });
  }, []);

  return (
    <Page>
      <PageTop
        eyebrow={dateLine}
        title="今天，穿点喜欢的。"
        right={
          <Button
            variant="round"
            avatar
            label="林"
            accessibilityLabel="我的资料"
            onPress={() => router.push('/profile')}
          />
        }
      />

      <Pressable
        accessibilityRole="button"
        onPress={() => setSceneOpen(true)}
        style={({ pressed }) => [styles.weather, pressed && styles.pressed]}>
        <Icon name="sun" size={28} color={colors.weatherIcon} />
        <View style={styles.weatherText}>
          <Text style={styles.weatherMain}>
            {context.city} {context.temp}　晴间多云
          </Text>
          <Text style={styles.weatherSub}>
            {context.day} · {context.scene}　天气为示例
          </Text>
        </View>
        <Icon name="chevron" size={15} color={colors.ink} />
      </Pressable>

      {newUser ? (
        <View style={styles.onboarding}>
          <Tag label="从一件开始就好" />
          <Text style={styles.onboardingTitle}>先认识你喜欢的那件。</Text>
          <Text style={styles.onboardingText}>
            拍一张照片，其他资料以后慢慢补。{'\n'}不需要先整理完整个衣橱。
          </Text>
          <Button
            variant="primary"
            icon="plus"
            label="添加第一件衣服"
            onPress={() => router.push('/add')}
          />
        </View>
      ) : (
        <>
          <View style={styles.hero}>
            <LookArt look={0} style={styles.heroArt} />
            <View style={styles.heroCopy}>
              <Text style={styles.heroTiny}>今日衣橱灵感</Text>
              <Text style={styles.heroTitle}>{'熟悉的衣服，\n新的默契。'}</Text>
              <Text style={styles.heroText}>{'温柔的针织，利落的线条。\n把舒服穿进日常。'}</Text>
            </View>
            <View style={styles.heroTag}>
              <Text style={styles.heroTagText}>虚构模特 · 搭配示意</Text>
            </View>
          </View>
          <Button
            variant="primary"
            icon="spark"
            label="从一件衣服开始搭配"
            onPress={() => router.push('/choose')}
            style={styles.homeCta}
          />
          <Text style={styles.underNote}>只用已有的衣服，也能有新鲜感</Text>
        </>
      )}

      <View style={styles.sectionHead}>
        <Text style={type.sectionHead}>{newUser ? '先看看示例' : '衣橱里的老朋友'}</Text>
        <Button variant="text" label="查看衣橱" onPress={() => router.push('/wardrobe')} />
      </View>
      <View style={styles.miniGrid}>
        {['knit', 'pants', 'bag'].map((id) => (
          <View key={id} style={styles.miniCell}>
            <ItemArt x={miniPos[id][0]} y={miniPos[id][1]} radius={13} />
            <Text style={styles.miniName} numberOfLines={1}>
              {miniName[id]}
            </Text>
          </View>
        ))}
      </View>
      <View style={styles.sectionHead}>
        <Text style={type.sectionHead}>不急着买，先好好穿。</Text>
      </View>
      <Text style={styles.subtitle}>让每一件衣服，多一种可能。</Text>

      <SceneSheet visible={sceneOpen} onClose={() => setSceneOpen(false)} />
    </Page>
  );
}

// 雪碧图列/行偏移与名称（与 data/demo 一致）
const miniPos: Record<string, [number, number]> = {
  knit: [0, 0],
  pants: [50, 0],
  bag: [100, 100],
};
const miniName: Record<string, string> = {
  knit: '奶油白针织衫',
  pants: '炭灰色阔腿裤',
  bag: '巧克力肩包',
};

const styles = StyleSheet.create({
  pressed: {
    opacity: 0.85,
  },
  weather: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    width: '100%',
    paddingVertical: 13,
    paddingHorizontal: 14,
    borderRadius: radius.weather,
    backgroundColor: colors.soft,
    marginBottom: 21,
  },
  weatherText: {
    flex: 1,
  },
  weatherMain: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '500',
    lineHeight: 18,
  },
  weatherSub: {
    color: colors.muted,
    fontSize: 10,
    lineHeight: 14,
    marginTop: 4,
  },

  hero: {
    minHeight: 273,
    borderRadius: radius.hero,
    overflow: 'hidden',
    backgroundColor: colors.heroBg,
  },
  heroArt: {
    position: 'absolute',
    right: -12,
    top: -7,
    width: '62%',
    height: 315,
  },
  heroCopy: {
    width: '55%',
    paddingLeft: 22,
    paddingTop: 27,
    // 底部给“虚构模特”角标留位，字体放大文字换行增多时容器随之撑高
    paddingBottom: 68,
  },
  heroTiny: {
    fontSize: 11,
    lineHeight: 16,
    color: colors.heroTiny,
  },
  heroTitle: {
    ...type.titleXL,
    color: colors.ink,
    marginVertical: 12,
  },
  heroText: {
    fontSize: 11,
    lineHeight: 19,
    color: colors.heroCopy,
  },
  heroTag: {
    position: 'absolute',
    left: 20,
    bottom: 20,
    backgroundColor: colors.heroTagBg,
    borderRadius: 6,
    paddingHorizontal: 9,
    paddingVertical: 6,
  },
  heroTagText: {
    fontSize: 10,
    lineHeight: 14,
    color: colors.ink,
  },
  homeCta: {
    marginTop: 14,
    marginBottom: 8,
  },
  underNote: {
    textAlign: 'center',
    fontSize: 10,
    lineHeight: 14,
    color: colors.muted,
  },

  onboarding: {
    padding: 23,
    borderRadius: radius.board,
    backgroundColor: colors.onboardingBg,
    marginVertical: 20,
    gap: 8,
  },
  onboardingTitle: {
    ...type.heading,
    fontSize: 20,
    lineHeight: 28,
    color: colors.ink,
    marginTop: 8,
  },
  onboardingText: {
    fontSize: 12,
    lineHeight: 21,
    color: colors.onboardingText,
    marginBottom: 17,
  },

  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 23,
    marginBottom: 12,
  },
  miniGrid: {
    flexDirection: 'row',
    gap: 9,
  },
  miniCell: {
    flex: 1,
  },
  miniName: {
    fontSize: 10,
    lineHeight: 14,
    color: colors.miniText,
    marginTop: 7,
  },
  subtitle: {
    fontSize: 12,
    lineHeight: 19,
    color: colors.muted,
    marginTop: 6,
  },
});

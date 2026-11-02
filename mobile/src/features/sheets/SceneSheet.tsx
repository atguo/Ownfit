import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { Sheet } from '../../ui/components/Sheet';
import { Field, ChipSelect, TextField } from '../../ui/components/Field';
import { Notice } from '../../ui/components/Basics';
import { Button } from '../../ui/components/Button';
import { useToast } from '../../ui/components/Toast';
import { setContext, useDemoStore } from '../demoStore';
import { saveSceneDefault } from '../../data/repositories/settingsRepository';
import { fetchTodayWeather, type WeatherSnapshot } from '../../services/weather';
import { dayOptions, sceneOptions } from '../../data/demo';
import { colors, type } from '../../ui/tokens';

// 调整当天场景（天气文档 §4.1）：常用场景只是默认值，当次调整不自动覆盖长期默认——
// 因此“用于这次搭配”只写当次；“保存为常用”才写默认值（用户明确选择）。
// 天气（M5 轨 C）：可选联网查实时（open-meteo，只发城市名，不发送衣橱或人物资料）；
// 失败或未查时保持手动可填；手动输入与服务数据来源可区分（tempSource：demo/real/manual）。

export function SceneSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { context } = useDemoStore();
  const toast = useToast();
  const [city, setCity] = useState(context.city);
  const [day, setDay] = useState(context.day);
  const [scene, setScene] = useState(context.scene);
  const [manualTemp, setManualTemp] = useState('');
  const [weather, setWeather] = useState<WeatherSnapshot | null>(null);
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [weatherError, setWeatherError] = useState<string | null>(null);

  async function loadWeather() {
    const trimmed = city.trim();
    if (!trimmed) {
      setWeatherError('请先填写城市名');
      return;
    }
    setWeatherLoading(true);
    setWeatherError(null);
    setWeather(null);
    try {
      const result = await fetchTodayWeather(trimmed);
      if (result.ok) {
        setWeather(result.snapshot);
      } else {
        // 失败如实提示，保留手动填写（不伪造预报）
        setWeatherError(`${result.message}。可手动填写温度。`);
      }
    } finally {
      setWeatherLoading(false);
    }
  }

  /** 温度来源：实时天气优先，其次手动输入；都没有则保持现状（不覆盖） */
  function resolveTemp(): { temp: string; weatherDesc: string; source: 'real' | 'manual' } | null {
    if (weather) {
      return { temp: weather.tempRange, weatherDesc: weather.description, source: 'real' };
    }
    const manual = manualTemp.trim();
    if (manual) {
      return { temp: manual, weatherDesc: '手动填写', source: 'manual' };
    }
    return null;
  }

  function applyToCurrent() {
    const tempInfo = resolveTemp();
    setContext({
      city: city.trim() || '未设置地点',
      day,
      scene,
      ...(tempInfo
        ? { temp: tempInfo.temp, weatherDesc: tempInfo.weatherDesc, tempSource: tempInfo.source }
        : null),
    });
    onClose();
    toast(tempInfo?.source === 'real' ? '已更新当次场景（实时天气）' : '已更新当次场景');
  }

  async function saveAsDefault() {
    await saveSceneDefault({ city: city.trim() || '未设置地点', day, scene });
    setContext({ city: city.trim() || '未设置地点', day, scene });
    onClose();
    toast('已保存为常用场景');
  }

  return (
    <Sheet visible={visible} title="今天，要去哪里？" onClose={onClose}>
      <Text style={styles.description}>只调整本次搭配，不改变长期偏好。</Text>
      <Field label="地点">
        <TextField value={city} maxLength={20} onChangeText={setCity} placeholder="所在地点" />
      </Field>
      <Field label="日期">
        <ChipSelect options={dayOptions} value={day} onChange={setDay} />
      </Field>
      <Field label="场景">
        <ChipSelect options={sceneOptions} value={scene} onChange={setScene} />
      </Field>

      <Field label="天气（可选）">
        <Button
          variant="secondary"
          label={weatherLoading ? '查询中…' : '查实时天气（需联网）'}
          onPress={() => void loadWeather()}
          disabled={weatherLoading}
        />
        {weather ? (
          <Notice>
            {`${weather.tempRange} · ${weather.description}（open-meteo 实时预报，${weather.fetchedAt.slice(11, 16)} 获取）`}
          </Notice>
        ) : null}
        {weatherError ? <Notice>{weatherError}</Notice> : null}
        <TextField
          value={manualTemp}
          maxLength={12}
          onChangeText={setManualTemp}
          placeholder="或手动填写，如 18–24℃"
          style={styles.tempInput}
        />
        {context.tempSource === 'real' ? (
          <Text style={styles.sourceNote}>当前为实时天气 {context.temp}（本次调整会覆盖）。</Text>
        ) : context.tempSource === 'manual' ? (
          <Text style={styles.sourceNote}>当前为手动填写 {context.temp}（本次调整会覆盖）。</Text>
        ) : (
          <Text style={styles.sourceNote}>当前为演示温度 {context.temp}；查实时或手动填写后覆盖。</Text>
        )}
      </Field>

      <Button variant="primary" label="用于这次搭配" onPress={applyToCurrent} />
      <Button variant="secondary" label="保存为常用场景" onPress={saveAsDefault} style={styles.gap} />
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
  tempInput: {
    marginTop: 8,
  },
  sourceNote: {
    ...type.footnote,
    color: colors.muted,
    marginTop: 6,
  },
  gap: {
    alignSelf: 'stretch',
    marginTop: 10,
  },
});

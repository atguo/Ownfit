import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { Sheet } from '../../ui/components/Sheet';
import { Field, ChipSelect, TextField } from '../../ui/components/Field';
import { Notice } from '../../ui/components/Basics';
import { Button } from '../../ui/components/Button';
import { useToast } from '../../ui/components/Toast';
import { DEMO_WEATHER, setContext, useDemoStore } from '../demoStore';
import { saveSceneDefault } from '../../data/repositories/settingsRepository';
import { fetchTodayWeather, pickCurrentTemp, type WeatherSnapshot } from '../../services/weather';
import { dayOptions, sceneOptions } from '../../data/demo';
import { colors, type } from '../../ui/tokens';

// 调整当天场景（天气文档 §4.1）：常用场景只是默认值，当次调整不自动覆盖长期默认——
// 因此“用于这次搭配”只写当次；“保存为常用”才写默认值（用户明确选择）。
// 天气（M5 轨 C）：可选联网查实时（open-meteo，只发城市名，不发送衣橱或人物资料）；
// 失败或未查时保持手动可填；手动输入与服务数据来源可区分（tempSource：demo/real/manual）。
// 失效处理（M6 批次 1.3）：实时天气是"某城市某日"的数据——改城市/改日期即失效并清空重查；
// 未提供新温度时，旧实时温度回退为示例占位（明确标注），不把旧天气冒充新地点/新日期的天气。

/** 本地时区 HH:mm（fetchedAt 是 UTC ISO；不用 UTC 截取冒充本地时间） */
function formatLocalTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function SceneSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { context } = useDemoStore();
  const toast = useToast();
  const [city, setCity] = useState(context.city);
  const [day, setDay] = useState(context.day);
  const [scene, setScene] = useState(context.scene);
  const [manualTemp, setManualTemp] = useState('');
  const [weather, setWeather] = useState<WeatherSnapshot | null>(null);
  /** 当前 weather 归属的城市与日期；城市/日期改动后不匹配即失效清空 */
  const [weatherFor, setWeatherFor] = useState<{ city: string; day: string } | null>(null);
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [weatherError, setWeatherError] = useState<string | null>(null);

  /** 城市/日期变化使已查天气失效（数据只对查询时的城市与"今天"成立） */
  function invalidateWeather(nextCity: string, nextDay: string) {
    if (!weatherFor) return;
    if (nextCity.trim() !== weatherFor.city || nextDay !== weatherFor.day) {
      setWeather(null);
      setWeatherFor(null);
      setWeatherError(null);
    }
  }

  async function loadWeather() {
    const trimmed = city.trim();
    if (!trimmed) {
      setWeatherError('请先填写城市名');
      return;
    }
    if (day !== '今天') {
      // 实时服务只返回今日预报；不把今日预报冒充"明天"的天气
      setWeatherError('实时天气仅提供今日预报；选择「明天」时请手动填写温度。');
      return;
    }
    setWeatherLoading(true);
    setWeatherError(null);
    setWeather(null);
    try {
      const result = await fetchTodayWeather(trimmed);
      if (result.ok) {
        setWeather(result.snapshot);
        setWeatherFor({ city: trimmed, day });
      } else {
        // 失败如实提示，保留手动填写（不伪造预报）
        setWeatherError(`${result.message}。可手动填写温度。`);
      }
    } finally {
      setWeatherLoading(false);
    }
  }

  /** 温度来源（M6 批次 1.3 用 pickCurrentTemp）：实时天气仅适用于今天，其次手动输入；都没有保持现状 */
  function resolveTemp(): { temp: string; weatherDesc: string; source: 'real' | 'manual' } | null {
    return pickCurrentTemp({ day, manualTemp, weather });
  }

  /**
   * 场景落当次。温度规则：
   * - 有新温度（实时/手动）→ 应用并记录获取时间；
   * - 无新温度且地点/日期有变化 → 旧实时温度失效，回退示例占位（明确标注，不冒充新地点天气）；
   * - 无新温度且地点/日期没变 → 保持现状（不覆盖）。
   */
  function applyWeather(change: { city: string; day: '今天' | '明天'; scene: string }) {
    const tempInfo = resolveTemp();
    const locationChanged =
      change.city !== context.city || change.day !== context.day;
    setContext({
      ...change,
      ...(tempInfo
        ? {
            temp: tempInfo.temp,
            weatherDesc: tempInfo.weatherDesc,
            tempSource: tempInfo.source,
            ...(tempInfo.source === 'real' && weather ? { weatherFetchedAt: weather.fetchedAt } : { weatherFetchedAt: undefined }),
          }
        : locationChanged && context.tempSource === 'real'
          ? { ...DEMO_WEATHER, tempSource: 'demo', weatherFetchedAt: undefined }
          : null),
    });
  }

  function applyToCurrent() {
    const change = { city: city.trim() || '未设置地点', day, scene };
    applyWeather(change);
    onClose();
    toast(resolveTemp()?.source === 'real' ? '已更新当次场景（实时天气）' : '已更新当次场景');
  }

  async function saveAsDefault() {
    const change = { city: city.trim() || '未设置地点', day, scene };
    await saveSceneDefault(change);
    applyWeather(change);
    onClose();
    toast('已保存为常用场景');
  }

  return (
    <Sheet visible={visible} title="今天，要去哪里？" onClose={onClose}>
      <Text style={styles.description}>只调整本次搭配，不改变长期偏好。</Text>
      <Field label="地点">
        <TextField
          value={city}
          maxLength={20}
          onChangeText={(next) => {
            setCity(next);
            invalidateWeather(next, day);
          }}
          placeholder="所在地点"
        />
      </Field>
      <Field label="日期">
        <ChipSelect
          options={dayOptions}
          value={day}
          onChange={(next) => {
            setDay(next);
            invalidateWeather(city, next);
          }}
        />
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
            {`${weather.tempRange} · ${weather.description}（open-meteo 实时预报，${formatLocalTime(weather.fetchedAt) || '时间未知'} 获取；仅适用于 ${weatherFor?.day ?? '今天'}的 ${weatherFor?.city ?? ''}）`}
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
          <Text style={styles.sourceNote}>
            当前为实时天气 {context.temp}
            {context.weatherFetchedAt ? `（${formatLocalTime(context.weatherFetchedAt)} 获取）` : ''}
            （改地点/日期后需重新查询）。
          </Text>
        ) : context.tempSource === 'manual' ? (
          <Text style={styles.sourceNote}>当前为手动填写 {context.temp}（本次调整会覆盖）。</Text>
        ) : (
          <Text style={styles.sourceNote}>当前为演示温度 {context.temp}；查实时或手动填写后覆盖。</Text>
        )}
      </Field>

      <Button variant="primary" label="用于这次搭配" onPress={applyToCurrent} />
      <Button variant="secondary" label="保存为常用场景" onPress={() => void saveAsDefault()} style={styles.gap} />
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

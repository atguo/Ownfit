// 自动天气服务（M5 轨 C，天气文档 §4）：open-meteo（免 Key）。
// 边界（功能文档）：
// - 可选联网：查询只发送城市名与日期，不发送衣橱或人物资料；不用定位（手动选城市）。
// - 失败/超时如实返回错误，由调用方提示并允许手动输入——绝不把猜测当预报。
// - 结果带来源与获取时间，手动输入与服务数据可区分（由调用方标注）。

export interface WeatherSnapshot {
  /** 摘要，如 "12–19℃" */
  tempRange: string;
  minC: number;
  maxC: number;
  /** WMO 天气码对应的中文描述 */
  description: string;
  weatherCode: number;
  /** 获取时间（ISO） */
  fetchedAt: string;
}

export type WeatherResult =
  | { ok: true; snapshot: WeatherSnapshot }
  | { ok: false; kind: 'city_not_found' | 'network' | 'timeout' | 'server' | 'no_data'; message: string };

const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const TIMEOUT_MS = 12000;

/** WMO weather code → 中文描述（open-meteo 官方表） */
const WMO_DESCRIPTIONS: Record<number, string> = {
  0: '晴', 1: '大致晴朗', 2: '多云', 3: '阴',
  45: '雾', 48: '雾凇',
  51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨',
  56: '冻毛毛雨', 57: '强冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '强冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '小阵雨', 81: '阵雨', 82: '强阵雨',
  85: '小阵雪', 86: '阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷阵雨伴冰雹',
};

function describeCode(code: number | undefined | null): string {
  if (typeof code !== 'number') return '未知天气';
  return WMO_DESCRIPTIONS[code] ?? '未知天气';
}

async function fetchJson(url: string, timeoutMs = TIMEOUT_MS): Promise<{ ok: true; value: unknown } | { ok: false; kind: 'network' | 'timeout' | 'server'; message: string }> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return { ok: false, kind: 'server', message: `天气服务返回 HTTP ${response.status}` };
    }
    return { ok: true, value: await response.json() };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return aborted
      ? { ok: false, kind: 'timeout', message: '天气服务请求超时' }
      : { ok: false, kind: 'network', message: `网络失败：${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timer);
  }
}

/** 城市名 → 经纬度（geocoding API，取第一个结果） */
export async function geocodeCity(city: string): Promise<{ ok: true; lat: number; lon: number; label: string } | WeatherResult> {
  const trimmed = city.trim();
  if (!trimmed) return { ok: false, kind: 'city_not_found', message: '请先填写城市名' };
  const url = `${GEO_URL}?name=${encodeURIComponent(trimmed)}&count=1&language=zh&format=json`;
  const result = await fetchJson(url);
  if (!result.ok) return { ok: false, kind: result.kind, message: result.message };
  const payload = result.value as { results?: Array<{ latitude: number; longitude: number; name: string; admin1?: string }> };
  const hit = payload.results?.[0];
  if (!hit) return { ok: false, kind: 'city_not_found', message: `没有找到城市「${trimmed}」，可换个写法或手动填写温度` };
  const label = [hit.name, hit.admin1].filter(Boolean).join(' · ');
  return { ok: true, lat: hit.latitude, lon: hit.longitude, label };
}

/**
 * 当次场景的温度决策（纯函数，M6 批次 1.3）：实时天气只适用于"今天"——
 * 预报仅返回今日，选择「明天」时今日预报不适用，回退手动输入；两者皆无返回 null
 * （保持现状不覆盖）。来源随结果返回，手动与实时可区分（天气文档 §4）。
 */
export function pickCurrentTemp(input: {
  day: string;
  manualTemp: string;
  weather: { tempRange: string; description: string } | null;
}): { temp: string; weatherDesc: string; source: 'real' | 'manual' } | null {
  if (input.weather && input.day === '今天') {
    return { temp: input.weather.tempRange, weatherDesc: input.weather.description, source: 'real' };
  }
  const manual = input.manualTemp.trim();
  if (manual) {
    return { temp: manual, weatherDesc: '手动填写', source: 'manual' };
  }
  return null;
}

function parseForecast(payload: {
  daily?: { temperature_2m_max?: number[]; temperature_2m_min?: number[]; weather_code?: number[] };
}): WeatherResult {
  const max = payload.daily?.temperature_2m_max?.[0];
  const min = payload.daily?.temperature_2m_min?.[0];
  const code = payload.daily?.weather_code?.[0];
  if (typeof max !== 'number' || typeof min !== 'number') {
    return { ok: false, kind: 'no_data', message: '天气服务没有返回今日温度' };
  }
  return {
    ok: true,
    snapshot: {
      tempRange: `${Math.round(min)}–${Math.round(max)}℃`,
      minC: min,
      maxC: max,
      description: describeCode(code),
      weatherCode: typeof code === 'number' ? code : -1,
      fetchedAt: new Date().toISOString(),
    },
  };
}

/** 坐标 → 今日预报（定位路径：跳过城市名解析；坐标已在定位层降精度） */
export async function fetchTodayWeatherByCoords(lat: number, lon: number): Promise<WeatherResult> {
  const url =
    `${FORECAST_URL}?latitude=${lat}&longitude=${lon}` +
    '&daily=temperature_2m_max,temperature_2m_min,weather_code&forecast_days=1&timezone=auto';
  const result = await fetchJson(url);
  if (!result.ok) return { ok: false, kind: result.kind, message: result.message };
  return parseForecast(result.value as Parameters<typeof parseForecast>[0]);
}

/** 城市名 → 今日天气（geocoding + forecast 两次调用；任一失败如实返回） */
export async function fetchTodayWeather(city: string): Promise<WeatherResult> {
  const geo = await geocodeCity(city);
  if (!('lat' in geo)) return geo as WeatherResult;
  return fetchTodayWeatherByCoords(geo.lat, geo.lon);
}

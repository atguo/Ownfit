// 自动天气编排（M6 批次 1 补充，2026-11-03 项目用户确认"打开 APP 自动查询地理位置和天气"）：
// APP 启动与回到前台时自动执行：定位（location.ts：缓存位置优先 + 实定位重试）→ 按降精度坐标
// 查今日天气 → 写入当次 context，首页天气条直接显示实时温度；失败保持现状不打扰，
// 场景弹层内可手动重查/手动填写。节流：已有实时天气且获取时间未过期（2 小时内且未跨日）则跳过；
// force=true（弹层手动重查）忽略节流。防重入：同一时刻只跑一次（启动/回前台/弹层可能并发）。

import { getContextSnapshot, setContext } from './demoStore';
import { locateCity, type LocatedPlace } from '../services/location';
import { fetchTodayWeatherByCoords, type WeatherSnapshot } from '../services/weather';

export interface WeatherRefreshResult {
  place: LocatedPlace | null;
  weather: WeatherSnapshot | null;
  locateMessage: string | null;
  weatherMessage: string | null;
  /** 本次是否真正执行了定位与请求（false = 节流跳过，context 已是新鲜实时天气） */
  ran: boolean;
}

/** 实时天气的新鲜度上限：超过 2 小时视为过期，回前台时自动重查 */
const FRESH_MAX_AGE_MS = 2 * 60 * 60 * 1000;

let inFlight: Promise<WeatherRefreshResult> | null = null;

function contextWeatherFresh(): boolean {
  const context = getContextSnapshot();
  if (context.tempSource !== 'real' || !context.weatherFetchedAt) return false;
  const fetchedAt = new Date(context.weatherFetchedAt).getTime();
  if (Number.isNaN(fetchedAt)) return false;
  if (Date.now() - fetchedAt > FRESH_MAX_AGE_MS) return false;
  // 跨日失效：获取时间不是本地今天 → 重新查
  const now = new Date();
  const fetched = new Date(fetchedAt);
  return (
    fetched.getFullYear() === now.getFullYear() &&
    fetched.getMonth() === now.getMonth() &&
    fetched.getDate() === now.getDate()
  );
}

async function run(force: boolean): Promise<WeatherRefreshResult> {
  if (!force && contextWeatherFresh()) {
    return { place: null, weather: null, locateMessage: null, weatherMessage: null, ran: false };
  }

  const locate = await locateCity(true);
  if (!locate.ok) {
    // 定位失败（拒绝/超时/关闭）：context 保持现状，不写任何天气
    return { place: null, weather: null, locateMessage: locate.message, weatherMessage: null, ran: true };
  }

  const weather = await fetchTodayWeatherByCoords(locate.place.lat, locate.place.lon);
  if (!weather.ok) {
    // 定位成功但天气失败：城市仍写回（用户可核对），温度保持现状不伪造
    setContext({ city: locate.place.label });
    return {
      place: locate.place,
      weather: null,
      locateMessage: null,
      weatherMessage: `${weather.message}。可在场景弹层手动填写温度`,
      ran: true,
    };
  }

  setContext({
    city: locate.place.label,
    temp: weather.snapshot.tempRange,
    weatherDesc: weather.snapshot.description,
    tempSource: 'real',
    weatherFetchedAt: weather.snapshot.fetchedAt,
  });
  return {
    place: locate.place,
    weather: weather.snapshot,
    locateMessage: null,
    weatherMessage: null,
    ran: true,
  };
}

/** 启动/回前台/弹层打开时调用；并发调用共享同一次执行 */
export function refreshCurrentWeather(options: { force?: boolean } = {}): Promise<WeatherRefreshResult> {
  if (!inFlight) {
    inFlight = run(options.force ?? false).finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

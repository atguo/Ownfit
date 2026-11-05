// 自动天气编排（M6 批次 1 补充，2026-11-03 项目用户确认"打开 APP 自动查询地理位置和天气"）：
// APP 启动与回到前台时自动执行：定位（location.ts：缓存位置优先 + 实定位重试）→ 按降精度坐标
// 查今日天气 → 写入当次 context，首页天气条直接显示实时温度；失败保持现状不打扰，
// 场景弹层内可手动重查/手动填写。节流：已有实时天气且获取时间未过期（2 小时内且未跨日）则跳过；
// force=true（弹层手动重查）忽略节流。防重入：同一时刻只跑一次（启动/回前台/弹层可能并发）。
// F4（2026-11-04，评估 §8.6）天气按目标日期与请求版本条件写回：
// - 请求开始记录当次 conditionRevision；响应只有在版本未变时才写回（请求期间用户改城市/
//   日期/手动温度 → 迟到响应整体丢弃，不让新条件等旧结果也不被旧结果覆盖）；
// - 写回带 weatherTargetDate（本地具体日期）与 weatherPlace（城市名）；消费端（推荐、展示）
//   据此判断失效——跨日、错位、超龄的实时数据不再冒充当前条件（消费校验在 recommendationStore）；
// - 定位/天气写回是请求内部更新（internal），不递增 revision；
// - 在途请求期间又来了新目标（force 或 revision 已变）→ 排一次以最新条件执行的跟进。

import { getContextSnapshot, setContext } from './demoStore';
import { locateCity, type LocatedPlace } from '../services/location';
import { fetchTodayWeatherByCoords, type WeatherSnapshot } from '../services/weather';

/** 天气不可用（城市变化/过期刷新失败）时的明确标注占位；
 * 文案与 demoStore 演示占位一致，独立定义避免反向依赖演示层。 */
const WEATHER_PLACEHOLDER = { temp: '18–24℃', weatherDesc: '晴间多云（演示）' } as const;

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

/** 本地时区 yyyy-MM-dd */
export function localToday(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function contextWeatherFresh(): boolean {
  const context = getContextSnapshot();
  if (context.tempSource !== 'real' || !context.weatherFetchedAt) return false;
  const fetchedAt = new Date(context.weatherFetchedAt).getTime();
  if (Number.isNaN(fetchedAt)) return false;
  if (Date.now() - fetchedAt > FRESH_MAX_AGE_MS) return false;
  // 目标日期失效（F4）：记录了目标日期就以它为准；未记录（旧形状）回退"获取日=今天"
  const today = localToday();
  if (context.weatherTargetDate) return context.weatherTargetDate === today;
  const fetched = new Date(fetchedAt);
  return (
    fetched.getFullYear() === new Date().getFullYear() &&
    fetched.getMonth() === new Date().getMonth() &&
    fetched.getDate() === new Date().getDate()
  );
}

async function run(force: boolean): Promise<WeatherRefreshResult> {
  if (!force && contextWeatherFresh()) {
    return { place: null, weather: null, locateMessage: null, weatherMessage: null, ran: false };
  }

  // F4：请求版本 = 开始时的条件版本；目标日期 = 今天的本地具体日期
  const requestRevision = getContextSnapshot().conditionRevision ?? 0;
  const targetDate = localToday();

  const locate = await locateCity(true);
  if (!locate.ok) {
    // 定位失败（拒绝/超时/关闭）：context 保持现状，不写任何天气
    return { place: null, weather: null, locateMessage: locate.message, weatherMessage: null, ran: true };
  }

  // 请求期间用户改了条件（城市/日期/手动温度）：迟到响应整体丢弃，优先用户的最新条件
  if ((getContextSnapshot().conditionRevision ?? 0) !== requestRevision) {
    return {
      place: locate.place,
      weather: null,
      locateMessage: null,
      weatherMessage: '查询期间你手动修改了场景，这次结果没有写入；需要时可在场景弹层重新查询',
      ran: true,
    };
  }

  // R6/F4：自动查得的是"今天"的天气；用户当前查看「明天」时不得把今日温度写成明天——
  // 只写回城市供核对，温度保持现状（占位或手动值），提示手动填写
  if (getContextSnapshot().day !== '今天') {
    setContext({ city: locate.place.label }, { internal: true });
    return {
      place: locate.place,
      weather: null,
      locateMessage: null,
      weatherMessage: '已定位并查到今日天气，但你正在看「明天」；今日预报不适用于明天，请在场景弹层手动填写',
      ran: true,
    };
  }

  const weather = await fetchTodayWeatherByCoords(locate.place.lat, locate.place.lon);

  // F4：请求期间条件已变（用户操作）→ 响应作废（含失败降级路径，一视同仁）
  if ((getContextSnapshot().conditionRevision ?? 0) !== requestRevision) {
    return {
      place: locate.place,
      weather: null,
      locateMessage: null,
      weatherMessage: '查询期间你手动修改了场景，这次结果没有写入；需要时可在场景弹层重新查询',
      ran: true,
    };
  }

  if (!weather.ok) {
    // R6：城市变化后不得继续展示旧城市的温度（回退明确标注的占位）；
    // 既有实时天气已过期时降级为占位，不把过期值继续标成 real。
    const context = getContextSnapshot();
    const cityChanged = context.city !== locate.place.label;
    const previousRealStale = context.tempSource === 'real' && !contextWeatherFresh();
    if ((cityChanged && context.tempSource === 'real') || previousRealStale) {
      setContext(
        {
          city: locate.place.label,
          temp: WEATHER_PLACEHOLDER.temp,
          weatherDesc: WEATHER_PLACEHOLDER.weatherDesc,
          tempSource: 'demo',
          weatherFetchedAt: undefined,
          weatherTargetDate: undefined,
          weatherPlace: undefined,
        },
        { internal: true },
      );
    } else {
      // 城市仍写回（用户可核对）；同城市的瞬时失败保留其原有温度，不伪造来源
      setContext({ city: locate.place.label }, { internal: true });
    }
    return {
      place: locate.place,
      weather: null,
      locateMessage: null,
      weatherMessage: `${weather.message}。可在场景弹层手动填写温度`,
      ran: true,
    };
  }

  // 写回（内部更新，不递增 revision）：绑定目标日期与归属地点，消费端据此判断失效
  setContext(
    {
      city: locate.place.label,
      temp: weather.snapshot.tempRange,
      weatherDesc: weather.snapshot.description,
      tempSource: 'real',
      weatherFetchedAt: weather.snapshot.fetchedAt,
      weatherTargetDate: targetDate,
      weatherPlace: locate.place.label,
    },
    { internal: true },
  );
  return {
    place: locate.place,
    weather: weather.snapshot,
    locateMessage: null,
    weatherMessage: null,
    ran: true,
  };
}

let inFlight: Promise<WeatherRefreshResult> | null = null;
let inFlightStartedRevision = 0;
let followUp: Promise<WeatherRefreshResult> | null = null;

/** 启动/回前台/弹层打开时调用；并发调用共享同一次执行（F4：条件已变时改排跟进执行） */
export function refreshCurrentWeather(options: { force?: boolean } = {}): Promise<WeatherRefreshResult> {
  const force = options.force ?? false;
  const revision = getContextSnapshot().conditionRevision ?? 0;
  if (!inFlight) {
    inFlightStartedRevision = revision;
    inFlight = run(force).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }
  // 旧请求在途时条件已变（或显式重查）：不把新调用者挂到旧结果上，
  // 排一次以最新条件执行的跟进（旧响应的正确性由写回条件保证，取消只是节省资源）
  if (followUp && (force || revision !== inFlightStartedRevision)) return followUp;
  if (!followUp && (force || revision !== inFlightStartedRevision)) {
    followUp = inFlight
      .catch(() => undefined)
      .then(() => run(true))
      .finally(() => {
        followUp = null;
      });
    return followUp;
  }
  return inFlight;
}

// 手机定位服务（M6 批次 1 补充，天气文档 §2"授权位置或手动选择"）：
// - 定位为主、手动为辅：权限未决定时请求一次；拒绝后不再自动重复请求，由用户点按钮重试或手动填写
// - 位置获取策略（2026-11-03 补充）：先取 10 分钟内的缓存位置（秒出，不等 GPS 收敛）；
//   没有缓存再实定位，单次 15 秒、失败退避 2 秒重试一次——冷启动首修慢是真机超时主因
// - 坐标精度降到 4 位小数（约 11 米）再外发，天气足够且少暴露精确位置
// - 坐标只发给天气服务（open-meteo）与城市名解析服务；绝不发送衣橱或人物资料；整体可拒绝用手动
// - 城市名解析链：平台逆地理（Android 无 GMS 时常不可用）→ 免 Key 解析服务（BigDataCloud 客户端接口）→
//   仍失败降级为"当前位置"占位（天气照常按坐标查询，不伪造城市名）

import * as Location from 'expo-location';

export interface LocatedPlace {
  /** 展示与存储的城市名（解析失败时为"当前位置"占位，resolved=false） */
  label: string;
  /** 天气查询坐标（已降精度） */
  lat: number;
  lon: number;
  /** 城市名是否来自真实解析（false = 占位，用户可手动改） */
  resolved: boolean;
}

export type LocateResult =
  | { ok: true; place: LocatedPlace }
  | {
      ok: false;
      kind: 'denied' | 'unavailable' | 'timeout' | 'network' | 'no_fix';
      message: string;
    };

const FIX_TIMEOUT_MS = 15000;
const RESOLVE_TIMEOUT_MS = 8000;
const RESOLVE_URL = 'https://api.bigdatacloud.net/data/reverse-geocode-client';
/** 缓存位置的新鲜度上限：10 分钟内的 lastKnown 直接采用（城市级天气足够，秒出不用等 GPS 收敛） */
const LAST_KNOWN_MAX_AGE_MS = 10 * 60 * 1000;
/** 实定位尝试次数：冷启动 GPS 首次收敛慢是真机超时主因，失败后短暂退避再试一次 */
const FIX_TRIES = 2;
const RETRY_DELAY_MS = 2000;

function round4(value: number): number {
  return Number(value.toFixed(4));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 平台逆地理：返回城市级名称；无 GMS 的国行设备常返回空，按失败处理 */
async function platformReverseGeocode(lat: number, lon: number): Promise<string | null> {
  try {
    const results = await withTimeout(
      Location.reverseGeocodeAsync({ latitude: lat, longitude: lon }),
      RESOLVE_TIMEOUT_MS,
    );
    const hit = results.find((r) => r.city || r.district || r.region);
    if (!hit) return null;
    return hit.city ?? hit.district ?? hit.region ?? null;
  } catch {
    return null;
  }
}

/** 免 Key 城市名解析（BigDataCloud 客户端接口）：仅发送降精度坐标与语言偏好 */
async function serviceReverseGeocode(lat: number, lon: number): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);
  try {
    const url = `${RESOLVE_URL}?latitude=${lat}&longitude=${lon}&localityLanguage=zh`;
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      city?: string;
      locality?: string;
      principalSubdivision?: string;
    };
    return payload.city ?? payload.locality ?? payload.principalSubdivision ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 定位当前城市。
 * @param promptWhenUndetermined 权限未决定时是否弹系统授权（自动定位=true；拒绝过的用户点按钮重试=true）
 * @param opts.fixTimeoutMs 单次实定位超时（测试可注入短超时；生产默认 15 秒）
 */
export async function locateCity(
  promptWhenUndetermined: boolean,
  opts: { fixTimeoutMs?: number } = {},
): Promise<LocateResult> {
  const fixTimeoutMs = opts.fixTimeoutMs ?? FIX_TIMEOUT_MS;
  try {
    const current = await Location.getForegroundPermissionsAsync();
    let granted = current.granted;
    if (!granted && current.canAskAgain && promptWhenUndetermined) {
      const requested = await Location.requestForegroundPermissionsAsync();
      granted = requested.granted;
    }
    if (!granted) {
      return {
        ok: false,
        kind: 'denied',
        message: '未获得定位权限，可手动填写城市；也可在系统设置中开启后点“使用当前位置”',
      };
    }

    const servicesOn = await Location.hasServicesEnabledAsync();
    if (!servicesOn) {
      return { ok: false, kind: 'unavailable', message: '系统定位服务未开启，开启后可自动定位' };
    }

    let fix: { coords: { latitude: number; longitude: number } } | null = null;
    // 先取缓存位置（10 分钟内）：打开即用，不等 GPS 收敛
    try {
      const last = await Location.getLastKnownPositionAsync({ maxAge: LAST_KNOWN_MAX_AGE_MS });
      if (last) fix = { coords: last.coords };
    } catch {
      // 缓存不可用继续实定位
    }

    // 缓存没有/过期：实定位，失败退避重试（冷启动首修耗时常超 10s，真机超时主因）
    let lastError: 'timeout' | 'no_fix' = 'no_fix';
    for (let attempt = 0; !fix && attempt < FIX_TRIES; attempt += 1) {
      if (attempt > 0) await sleep(RETRY_DELAY_MS);
      try {
        const current = await withTimeout(
          Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
          fixTimeoutMs,
        );
        fix = { coords: current.coords };
      } catch (error) {
        lastError = error instanceof Error && error.message === 'timeout' ? 'timeout' : 'no_fix';
      }
    }
    if (!fix) {
      return {
        ok: false,
        kind: lastError,
        message:
          lastError === 'timeout'
            ? '定位超时（已自动重试），可稍后再试或手动填写'
            : '暂时拿不到定位，可手动填写城市',
      };
    }

    const lat = round4(fix.coords.latitude);
    const lon = round4(fix.coords.longitude);

    // 城市名解析链：平台逆地理 → 免 Key 服务 → "当前位置"占位（天气按坐标查，不因名字失败而失败）
    const label = (await platformReverseGeocode(lat, lon)) ?? (await serviceReverseGeocode(lat, lon));
    if (!label) {
      return {
        ok: true,
        place: { label: '当前位置', lat, lon, resolved: false },
      };
    }
    return { ok: true, place: { label, lat, lon, resolved: true } };
  } catch (error) {
    return {
      ok: false,
      kind: 'network',
      message: `定位失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// solarlunar 3.x 模块声明：包内自带 solarlunar.d.ts，但 package.json exports
// 映射缺 "types" 条件（3.1.0），tsc 解析不到；且其 ESM 构建仅默认导出——
// 按本项目消费面（solar2lunar）收窄声明。
interface SolarLunarResult {
  lYear: number;
  lMonth: number;
  lDay: number;
  animal: string;
  yearCn: string;
  monthCn: string;
  dayCn: string;
  cYear: number;
  cMonth: number;
  cDay: number;
  gzYear: string;
  gzMonth: string;
  gzDay: string;
  isToday: boolean;
  isLeap: boolean;
  nWeek: number;
  ncWeek: string;
  isTerm: boolean;
  term: string;
}

interface SolarLunarApi {
  solar2lunar(year?: number, month?: number, day?: number): SolarLunarResult | -1;
}

declare module "solarlunar" {
  const solarLunar: SolarLunarApi;
  export default solarLunar;
}

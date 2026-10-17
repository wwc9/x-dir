// 布局方案的随机默认名：两字自然意象词池。
// 选型理由：短（侧边栏窄列放得下）、中文语境可读易记、与"我的方案 2"式编号相比
// 更有辨识度；重名自动追加序号兜底。

const POOL = [
  "晚风", "晴川", "远山", "星野", "溪流", "白露", "青柠", "栖枝",
  "晨雾", "落霞", "松间", "竹影", "湖心", "云栖", "屿风", "汀兰",
  "初雪", "蝉夏", "拾光", "渡口", "南屿", "北巷", "花田", "麦浪",
  "空谷", "回声", "浮岛", "灯塔", "季风", "极光", "潮汐", "苔原",
];

export const POOL_SIZE = POOL.length;

/** 随机方案名：从词池取词；与已有方案重名时追加序号（晚风 2、晚风 3…）。
 *  rand 供测试注入，缺省 Math.random */
export function randomSchemeName(
  existing: string[],
  rand: () => number = Math.random,
): string {
  const taken = new Set(existing.map((e) => e.toLowerCase()));
  const word = POOL[Math.floor(rand() * POOL.length) % POOL.length];
  if (!taken.has(word)) return word;
  for (let i = 2; ; i++) {
    const name = `${word} ${i}`;
    if (!taken.has(name)) return name;
  }
}

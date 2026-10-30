// 截图标注纯函数测试（§3.6）：选区归一/调整、手柄命中、箭头头部与曲线
// 控制点、窗口命中、放大镜布局、序号徽标。
import { describe, expect, it } from "vitest";

import {
  MAGNIFIER_GAP,
  MAGNIFIER_SRC,
  MAGNIFIER_ZOOM,
  arrowCurveCtrl,
  arrowHead,
  arrowWingsAt,
  formatMagColor,
  formatMagCoords,
  handleAt,
  hexToRgba,
  hitWindow,
  magnifierBox,
  magnifierLayout,
  nextStepSeq,
  normalizeSel,
  resizeSel,
  selHandles,
  adjustShapeProp,
  shapeAt,
  shapeBounds,
  stepBadgeColor,
  stepBadgeSize,
  type Shape,
} from "../annot";

describe("normalizeSel", () => {
  it("负向拖拽翻正为包围盒", () => {
    expect(normalizeSel(100, 80, 40, 30, 1920, 1080)).toEqual({
      x: 40,
      y: 30,
      w: 60,
      h: 50,
    });
  });

  it("钳制到屏幕边界内", () => {
    expect(normalizeSel(-10, -10, 50, 50, 1920, 1080)).toEqual({
      x: 0,
      y: 0,
      w: 50,
      h: 50,
    });
    expect(normalizeSel(1900, 1070, 2000, 1200, 1920, 1080)).toEqual({
      x: 1900,
      y: 1070,
      w: 20,
      h: 10,
    });
  });

  it("小于最小尺寸视为点击返回 null", () => {
    expect(normalizeSel(10, 10, 12, 12, 1920, 1080)).toBeNull();
  });
});

describe("handleAt / resizeSel", () => {
  const sel = { x: 100, y: 100, w: 200, h: 100 };

  it("8 手柄位置与命中", () => {
    expect(selHandles(sel)).toHaveLength(8);
    expect(handleAt(sel, 100, 100)).toBe("nw");
    expect(handleAt(sel, 300, 200)).toBe("se");
    expect(handleAt(sel, 200, 100)).toBe("n");
    expect(handleAt(sel, 150, 150)).toBeNull(); // 选区中心不是手柄
  });

  it("拖角手柄调整并钳制", () => {
    expect(resizeSel(sel, "se", 400, 300, 1920, 1080)).toEqual({
      x: 100,
      y: 100,
      w: 300,
      h: 200,
    });
    // 拖出屏幕右缘：钳制不越界
    const r = resizeSel(sel, "se", 3000, 300, 1920, 1080);
    expect(r.x + r.w).toBeLessThanOrEqual(1920);
    // 拖 nw 到对角另一侧：保持 ≥8 且翻正
    const r2 = resizeSel(sel, "nw", 50, 180, 1920, 1080);
    expect(r2.x).toBe(50);
    expect(r2.h).toBeGreaterThanOrEqual(8);
  });
});

describe("arrowHead", () => {
  it("水平箭头两翼对称", () => {
    const h = arrowHead(0, 0, 100, 0, 20);
    expect(h).not.toBeNull();
    expect(h!.ay).toBeCloseTo(-h!.by, 5);
    expect(h!.ax).toBeLessThan(100);
    expect(h!.bx).toBeLessThan(100);
  });

  it("零长度线段返回 null", () => {
    expect(arrowHead(5, 5, 5, 5, 10)).toBeNull();
  });
});

describe("arrowWingsAt", () => {
  it("以给定切向角为中心两侧对称展开", () => {
    // 朝右（0 弧度）尖端在原点：两翼都在尖端左侧、上下对称
    const g = arrowWingsAt(0, 0, 0, 10);
    expect(g.ay).toBeCloseTo(-g.by, 5);
    expect(g.ax).toBeCloseTo(g.bx, 5);
    expect(g.ax).toBeLessThan(0);
  });

  it("arrowHead 与同角度的 arrowWingsAt 结果一致（曲线末端切向复用）", () => {
    const a = arrowHead(0, 0, 80, -60, 15);
    const b = arrowWingsAt(80, -60, Math.atan2(-60, 80), 15);
    expect(a).not.toBeNull();
    expect(a!.ax).toBeCloseTo(b.ax, 5);
    expect(a!.ay).toBeCloseTo(b.ay, 5);
  });
});

describe("arrowCurveCtrl", () => {
  it("控制点 = 中点沿方向左侧法线偏移 22% 线长", () => {
    // 水平向右：左法线 = (0, 1)（屏幕坐标 y 向下），控制点在中点正下方
    const c = arrowCurveCtrl(0, 0, 100, 0);
    expect(c.cx).toBeCloseTo(50, 5);
    expect(c.cy).toBeCloseTo(22, 5);
  });

  it("垂直向下：控制点在中点左侧", () => {
    const c = arrowCurveCtrl(0, 0, 0, 50);
    expect(c.cx).toBeCloseTo(-11, 5);
    expect(c.cy).toBeCloseTo(25, 5);
  });

  it("起终点重合退化为该点本身", () => {
    const c = arrowCurveCtrl(7, 9, 7, 9);
    expect(c).toEqual({ cx: 7, cy: 9 });
  });
});

describe("hitWindow", () => {
  // 候选按 z 序（前→后）：全屏桌面兜底在最末；前层小窗排最前
  const wins = [
    { x: 100, y: 100, w: 400, h: 300 },
    { x: 0, y: 0, w: 1920, h: 1080 },
  ];

  it("按 z 序命中（前层优先，而非面积最小）", () => {
    // 两候选矩形都包含该点：前层小窗在前，应命中前层
    expect(hitWindow(wins, 150, 150)).toEqual(wins[0]);
  });

  it("前层未覆盖处命中后层（桌面兜底）", () => {
    expect(hitWindow(wins, 1900, 1070)).toEqual(wins[1]);
    expect(hitWindow(wins, 50, 50)).toEqual(wins[1]);
  });

  it("未命中返回 null", () => {
    expect(hitWindow([], 10, 10)).toBeNull();
  });
});

describe("magnifierLayout", () => {
  const { box, barH } = magnifierBox();

  it("取景框尺寸 = 取样网格 × 放大倍率，信息条成比例", () => {
    expect(box).toBe(MAGNIFIER_SRC * MAGNIFIER_ZOOM);
    expect(barH).toBeGreaterThan(0);
    expect(barH).toBeLessThan(box);
  });

  it("屏内默认落在光标右下（留出间距）", () => {
    const l = magnifierLayout(100, 100, 1920, 1080);
    expect(l.boxX).toBe(100 + MAGNIFIER_GAP);
    expect(l.boxY).toBe(100 + MAGNIFIER_GAP);
    expect(l.barY).toBe(l.boxY + box);
  });

  it("靠近右缘向左翻转，靠近下缘向上翻转", () => {
    const right = magnifierLayout(1910, 500, 1920, 1080);
    expect(right.boxX).toBe(1910 - MAGNIFIER_GAP - box);
    const bottom = magnifierLayout(500, 1070, 1920, 1080);
    expect(bottom.boxY).toBe(1070 - MAGNIFIER_GAP - box - barH);
    expect(bottom.barY + barH).toBeLessThanOrEqual(1080);
  });

  it("右下角同时翻转且整体不出屏", () => {
    const l = magnifierLayout(1919, 1079, 1920, 1080);
    expect(l.boxX + box).toBeLessThanOrEqual(1920);
    expect(l.barY + barH).toBeLessThanOrEqual(1080);
    expect(l.boxX).toBeGreaterThanOrEqual(0);
    expect(l.boxY).toBeGreaterThanOrEqual(0);
  });

  it("极小屏不产生负坐标", () => {
    const l = magnifierLayout(5, 5, 100, 80);
    expect(l.boxX).toBeGreaterThanOrEqual(0);
    expect(l.boxY).toBeGreaterThanOrEqual(0);
    expect(l.barY).toBeGreaterThanOrEqual(box);
  });
});

describe("formatMagColor", () => {
  const rgba = [168, 187, 206, 255] as const;

  it("hex 大写输出", () => {
    expect(formatMagColor(rgba, "hex")).toBe("#A8BBCE");
  });

  it("rgb 逗号串输出", () => {
    expect(formatMagColor(rgba, "rgb")).toBe("rgb(168, 187, 206)");
  });

  it("低位字节补零", () => {
    expect(formatMagColor([0, 5, 16, 255] as const, "hex")).toBe("#000510");
  });
});

describe("formatMagCoords", () => {
  it("全局 = 显示器物理坐标", () => {
    expect(formatMagCoords(589, 2149, "global")).toBe("(589, 2149)");
  });

  it("相对 = 相对原点差值（带前缀标注）", () => {
    expect(formatMagCoords(589, 2149, "relative", { x: 500, y: 2100 })).toBe("相对 (89, 49)");
  });

  it("无 origin 的相对模式退回全局", () => {
    expect(formatMagCoords(589, 2149, "relative")).toBe("(589, 2149)");
  });
});

describe("hexToRgba", () => {
  it("六位 hex 转 rgba 串", () => {
    expect(hexToRgba("#3574f0", 0.25)).toBe("rgba(53,116,240,0.25)");
    expect(hexToRgba("#FFFFFF", 1)).toBe("rgba(255,255,255,1)");
  });

  it("非法输入退回白色", () => {
    expect(hexToRgba("rgb(1,2,3)", 0.5)).toBe("rgba(255,255,255,0.5)");
    expect(hexToRgba("#12345", 0.5)).toBe("rgba(255,255,255,0.5)");
  });
});

describe("nextStepSeq", () => {
  const step = (seq: number): Shape => ({
    type: "step",
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    color: "#e5484d",
    width: 4,
    seq,
  });
  const rect: Shape = { type: "rect", x: 0, y: 0, w: 9, h: 9, color: "#fff", width: 2 };

  it("无徽标从 1 起", () => {
    expect(nextStepSeq([])).toBe(1);
    expect(nextStepSeq([rect])).toBe(1);
  });

  it("取现有最大 seq + 1，只认 step 图形", () => {
    expect(nextStepSeq([step(1)])).toBe(2);
    expect(nextStepSeq([rect, step(1), step(2)])).toBe(3);
  });

  it("撤销摘掉最后徽标后数字回退复用（max+1 语义）", () => {
    // 落了 1、2 后 undo 摘 2 → 剩 [step1] → 下一个应复用 2
    const afterUndo = [step(1)];
    expect(nextStepSeq(afterUndo)).toBe(2);
  });

  it("重做带回原 seq 不影响后续递增", () => {
    const redone = [step(1), step(2)];
    expect(nextStepSeq(redone)).toBe(3);
  });
});

describe("stepBadgeColor", () => {
  it("深底配白字（色板红/蓝/黑）", () => {
    expect(stepBadgeColor("#e5484d")).toBe("#ffffff");
    expect(stepBadgeColor("#3b82f6")).toBe("#ffffff");
    expect(stepBadgeColor("#1c1c1c")).toBe("#ffffff");
  });

  it("亮底配近黑字（色板黄/白）", () => {
    expect(stepBadgeColor("#ffc53d")).toBe("#101010");
    expect(stepBadgeColor("#ffffff")).toBe("#101010");
  });

  it("非法色值按深色处理", () => {
    expect(stepBadgeColor("not-a-color")).toBe("#ffffff");
  });
});

describe("stepBadgeSize", () => {
  it("直径随线宽与 scale 放大，字号 = 直径 54%", () => {
    const s1 = stepBadgeSize(4, 1, 1);
    expect(s1.d).toBeCloseTo((16 + 4 * 2.6) * 1, 5);
    expect(s1.font).toBe(Math.round(s1.d * 0.54));
    const s15 = stepBadgeSize(4, 1.5, 1);
    expect(s15.d).toBeCloseTo(s1.d * 1.5, 5);
  });

  it("多位数按位数加宽且字号不超过直径", () => {
    const one = stepBadgeSize(4, 1.5, 1);
    const two = stepBadgeSize(4, 1.5, 2);
    expect(two.d).toBeCloseTo(one.d * 1.18, 5);
    expect(two.font).toBeLessThan(two.d);
  });
});

describe("shapeAt", () => {
  const rect: Shape = { type: "rect", x: 0, y: 0, w: 200, h: 100, color: "#fff", width: 4 };
  const badge: Shape = {
    type: "step",
    x: 150,
    y: 50,
    w: 0,
    h: 0,
    color: "#e5484d",
    width: 4,
    seq: 1,
  };

  it("矩形命中描边带而非包围盒中心", () => {
    expect(shapeAt([rect], 0, 50, 8)).toBe(0); // 左边框上
    expect(shapeAt([rect], 100, 50, 8)).toBeNull(); // 内部空白
    expect(shapeAt([rect], 200, 100, 8)).toBe(0); // 右下角
  });

  it("极小矩形整体命中", () => {
    const tiny: Shape = { ...rect, w: 8, h: 8 };
    expect(shapeAt([tiny], 4, 4, 8)).toBe(0);
  });

  it("序号徽标命中圆内、圆外未命中", () => {
    expect(shapeAt([badge], 150, 50, 8)).toBe(0);
    expect(shapeAt([badge], 150 + 40, 50, 8)).toBeNull(); // r=19.8 之外
  });

  it("笔迹命中折线段附近", () => {
    const pen: Shape = {
      type: "pen",
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      pts: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 80 },
      ],
      color: "#fff",
      width: 4,
    };
    expect(shapeAt([pen], 50, 6, 8)).toBe(0);
    expect(shapeAt([pen], 50, 60, 8)).toBeNull();
  });

  it("模糊/马赛克命中包围盒内", () => {
    const blur: Shape = { type: "blur", x: 10, y: 10, w: 100, h: 60, color: "#fff", width: 4 };
    expect(shapeAt([blur], 60, 40, 8)).toBe(0);
    expect(shapeAt([blur], 0, 40, 8)).toBeNull(); // 左缘外（>容差 8）
  });

  it("重叠取最上层（后画的在下标大）", () => {
    expect(shapeAt([rect, badge], 150, 50, 8)).toBe(1);
  });

  it("文字按估算 bbox 命中（CJK 全宽近似）", () => {
    const txt: Shape = { type: "text", x: 20, y: 20, w: 0, h: 0, color: "#fff", width: 22, text: "标注" };
    expect(shapeAt([txt], 20 + 22, 20 + 14, 8)).toBe(0); // 两字宽 ~44 内
    expect(shapeAt([txt], 20 + 90, 20 + 14, 8)).toBeNull();
  });
});

describe("shapeBounds", () => {
  it("矩形外扩半线宽（描边感知）", () => {
    const r: Shape = { type: "rect", x: 100, y: 50, w: 200, h: 100, color: "#fff", width: 4 };
    const b = shapeBounds(r, 1.5);
    expect(b).toEqual({ x: 97, y: 47, w: 206, h: 106 }); // pad = 4*1.5/2 = 3
  });

  it("笔迹取 pts 包围盒，马克笔按 3.5 倍线宽外扩", () => {
    const pen: Shape = {
      type: "pen",
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      pts: [
        { x: 10, y: 20 },
        { x: 110, y: 20 },
      ],
      color: "#fff",
      width: 4,
    };
    expect(shapeBounds(pen, 1)).toEqual({ x: 8, y: 18, w: 104, h: 4 });
    const mk = shapeBounds({ ...pen, type: "marker" }, 1);
    expect(mk.x).toBe(10 - 7); // 4*3.5/2
  });

  it("序号圈取徽标直径正方形", () => {
    const s: Shape = { type: "step", x: 150, y: 50, w: 0, h: 0, color: "#fff", width: 4, seq: 1 };
    const d = (16 + 4 * 2.6) * 1.5;
    const b = shapeBounds(s, 1.5);
    expect(b.x).toBeCloseTo(150 - d / 2, 5);
    expect(b.w).toBeCloseTo(d, 5);
  });

  it("文字 bbox 字号随 scale 成物理像素（CJK 全宽）", () => {
    const t: Shape = { type: "text", x: 20, y: 20, w: 0, h: 0, color: "#fff", width: 20, text: "注" };
    const b = shapeBounds(t, 1.5);
    expect(b.w).toBeCloseTo(30, 5); // 20*1.5 一字全宽
    expect(b.h).toBeCloseTo(40.5, 5); // 1.35 行高
  });

  it("马赛克/模糊面形不外扩", () => {
    const m: Shape = { type: "mosaic", x: 5, y: 5, w: 90, h: 50, color: "#fff", width: 7 };
    expect(shapeBounds(m, 1)).toEqual({ x: 5, y: 5, w: 90, h: 50 });
  });
});

describe("adjustShapeProp", () => {
  it("线形：线宽 ±1，钳 1~30", () => {
    const r: Shape = { type: "rect", x: 0, y: 0, w: 9, h: 9, color: "#fff", width: 5 };
    expect(adjustShapeProp(r, 1)).toEqual({ shape: { ...r, width: 6 }, label: "线宽 6px" });
    expect(adjustShapeProp({ ...r, width: 30 }, 1)?.shape.width).toBe(30);
    expect(adjustShapeProp({ ...r, width: 1 }, -1)?.shape.width).toBe(1);
  });

  it("文字：字号 ±2，钳 10~80", () => {
    const t: Shape = { type: "text", x: 0, y: 0, w: 0, h: 0, color: "#fff", width: 22, text: "a" };
    expect(adjustShapeProp(t, 1)?.shape.width).toBe(24);
    expect(adjustShapeProp({ ...t, width: 10 }, -1)?.shape.width).toBe(10);
    expect(adjustShapeProp(t, 1)?.label).toBe("字号 24px");
  });

  it("序号圈：±1 钳 1~20，HUD 报直径", () => {
    const s: Shape = { type: "step", x: 0, y: 0, w: 0, h: 0, color: "#fff", width: 4, seq: 1 };
    const up = adjustShapeProp(s, 1)!;
    expect(up.shape.width).toBe(5);
    expect(up.label).toBe("序号圈 29px"); // 16 + 5*2.6
  });

  it("模糊：不透明度 ±5% 钳 15%~100%，缺省 1 起", () => {
    const b: Shape = { type: "blur", x: 0, y: 0, w: 9, h: 9, color: "#fff", width: 4 };
    expect(adjustShapeProp(b, -1)).toEqual({
      shape: { ...b, alpha: 0.95 },
      label: "模糊不透明度 95%",
    });
    expect(adjustShapeProp({ ...b, alpha: 0.15 }, -1)?.shape.alpha).toBeCloseTo(0.15);
    expect(adjustShapeProp({ ...b, alpha: 0.95 }, 1)?.shape.alpha).toBe(1);
  });

  it("马赛克：±1 钳 2~20，HUD 报格宽", () => {
    const m: Shape = { type: "mosaic", x: 0, y: 0, w: 9, h: 9, color: "#fff", width: 4 };
    expect(adjustShapeProp(m, 1)?.label).toBe("马赛克 15px 格");
  });
});

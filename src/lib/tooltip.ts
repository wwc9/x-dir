// 全局委托式悬浮提示（2026-10-21 定案 · 方案 B 卡片键帽，120ms）：
// 监听 data-tip / data-kbd 属性渲染唯一浮层（.np-tip），替代原生 title
// （约 1s 延迟、系统样式不可控、快捷键无键帽质感）。内容截断场景
// （np-ellipsis 单元格等）保留原生 title 不走此组件。App.tsx 挂载一次。
// 行为：120ms 延迟淡入 + 轻微缩放；按钮下方居中、贴底自动上翻、视口钳制；
// mousedown（含拖拽起始）/ Escape / 滚动 / 窗口缩放 / 指针离开文档
// 即隐。
// 展示方向（2026-11-05 定案）：默认按钮**上方**——光标贴着按钮，下方
// tooltip 易挡住指针与下移视线；顶部工具区（标题栏 / 浮窗头，容器标
// data-tip-down）优先**下方**（上方贴窗口上缘空间小，翻转抖动）；
// 贴边自动向另一侧翻转。旧 data-tip-up（截图标注条 2026-10-30 的
// 优先上方）已并入默认行为，属性退役。主窗口 / 剪贴板浮窗 / 截图族
// 窗口统一本规则。
let el: HTMLDivElement | null = null;
let timer: number | null = null;
let cur: Element | null = null;
let downEl: Element | null = null;
const DELAY = 120;
const GAP = 6;
const EDGE = 8;

function hide() {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (el) {
    el.remove();
    el = null;
  }
  cur = null;
}

function show(target: Element) {
  const text = target.getAttribute("data-tip");
  if (!text) return;
  el = document.createElement("div");
  el.className = "np-tip";
  el.textContent = text;
  const kbd = target.getAttribute("data-kbd");
  if (kbd) {
    const k = document.createElement("kbd");
    k.textContent = kbd;
    el.appendChild(k);
  }
  // 图标钮多无可访问名：悬浮时顺手补 aria-label（一次性，不覆盖既有值）
  if (!target.getAttribute("aria-label") && !target.textContent?.trim()) {
    target.setAttribute("aria-label", text);
  }
  document.body.appendChild(el);
  position(target);
  requestAnimationFrame(() => el?.classList.add("np-tip-on"));
}

function position(target: Element) {
  if (!el) return;
  const r = target.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  // 方向：默认上方（见文件头 2026-11-05 定案）；data-tip-down 容器
  // （标题栏/浮窗头等顶部工具区）优先下方，贴边向另一侧自动翻转。
  // 顶部工具区水平落位 = 下右侧/下左侧（2026-11-05 补充定案）：tip 左缘贴
  // 按钮右缘侧向展开，视口右缘不足翻下左（tip 右缘贴按钮左缘）——tip 完全
  // 避开按钮水平投影，光标从按钮垂直下移的路径永不被挡（居中或边对齐
  // 都会被比按钮宽的 tip 横跨）
  const down = target.closest("[data-tip-down]") !== null;
  let x = r.left + r.width / 2 - w / 2;
  let y = down ? r.bottom + GAP : r.top - h - GAP;
  if (down ? y + h > window.innerHeight - EDGE : y < EDGE) {
    y = down ? r.top - h - GAP : r.bottom + GAP;
  }
  if (down) {
    x = r.right + 4;
    if (x + w > window.innerWidth - EDGE) x = r.left - w - 4;
  }
  x = Math.max(EDGE, Math.min(x, window.innerWidth - w - EDGE));
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
}

function enter(target: Element) {
  if (target === cur || target === downEl) return;
  hide();
  cur = target;
  timer = window.setTimeout(() => {
    timer = null;
    show(target);
  }, DELAY);
}

export function initTooltip(): () => void {
  const over = (e: Event) => {
    const t = (e.target as Element | null)?.closest?.("[data-tip]") ?? null;
    if (t) enter(t);
    else hide();
  };
  const focus = (e: FocusEvent) => {
    const t = (e.target as Element | null)?.closest?.("[data-tip]") ?? null;
    if (t) enter(t);
  };
  const down = (e: MouseEvent) => {
    downEl = (e.target as Element | null)?.closest?.("[data-tip]") ?? null;
    hide();
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape") hide();
  };
  document.addEventListener("mouseover", over);
  document.addEventListener("focusin", focus);
  document.addEventListener("mousedown", down);
  document.addEventListener("keydown", key);
  window.addEventListener("scroll", hide, true);
  window.addEventListener("resize", hide);
  document.documentElement.addEventListener("mouseleave", hide);
  return () => {
    hide();
    document.removeEventListener("mouseover", over);
    document.removeEventListener("focusin", focus);
    document.removeEventListener("mousedown", down);
    document.removeEventListener("keydown", key);
    window.removeEventListener("scroll", hide, true);
    window.removeEventListener("resize", hide);
    document.documentElement.removeEventListener("mouseleave", hide);
  };
}

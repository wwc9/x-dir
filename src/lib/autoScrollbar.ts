// 滚动条自动浮现（配合 index.css 的胶囊滚动条样式）：
// 给滚动容器临时打 .np-scrolling 显示拇指，两种触发——
//  1. 滚动中：全局捕获 scroll（scroll 不冒泡），静止 350ms 后隐藏；
//  2. 指针悬停：pointerover 时对指针位置的所有可滚动祖先打类，移出后隐藏。
// 悬停不用 CSS :hover 实现，因为 Chromium 不响应祖先 :hover 变化重绘滚动条伪元素，
// 但 class 变化会触发重绘。
const HIDE_DELAY_MS = 350;

export function setupAutoScrollbar(): () => void {
  const timers = new WeakMap<Element, number>();
  // 指针当前悬停链上的滚动容器（同时兼作滚动静止延迟到期时的在悬判断）
  let hoverChain: Element[] = [];

  const isScrollable = (el: Element) =>
    el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth;

  const show = (el: Element) => {
    el.classList.add("np-scrolling");
    const t = timers.get(el);
    if (t !== undefined) {
      window.clearTimeout(t);
      timers.delete(el);
    }
  };
  const hide = (el: Element) => {
    if (hoverChain.includes(el)) return;
    el.classList.remove("np-scrolling");
  };
  const hideLater = (el: Element) => {
    const prev = timers.get(el);
    if (prev !== undefined) window.clearTimeout(prev);
    timers.set(
      el,
      window.setTimeout(() => hide(el), HIDE_DELAY_MS),
    );
  };

  const onScroll = (e: Event) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    show(t);
    hideLater(t);
  };
  const onPointerOver = (e: PointerEvent) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const next: Element[] = [];
    for (let el: Element | null = t; el; el = el.parentElement) {
      if (isScrollable(el)) {
        next.push(el);
        show(el);
      }
    }
    for (const el of hoverChain) {
      if (!next.includes(el)) hideLater(el);
    }
    hoverChain = next;
  };
  // 指针离开窗口：清空悬停链
  const onPointerOut = (e: PointerEvent) => {
    if (e.relatedTarget) return;
    for (const el of hoverChain) hideLater(el);
    hoverChain = [];
  };

  document.addEventListener("scroll", onScroll, { capture: true, passive: true });
  document.addEventListener("pointerover", onPointerOver, true);
  document.addEventListener("pointerout", onPointerOut, true);
  return () => {
    document.removeEventListener("scroll", onScroll, true);
    document.removeEventListener("pointerover", onPointerOver, true);
    document.removeEventListener("pointerout", onPointerOut, true);
  };
}

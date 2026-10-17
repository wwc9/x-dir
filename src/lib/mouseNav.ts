// 鼠标 X1/X2 侧键 → 活动标签历史后退/前进（Explorer/浏览器惯例）。
// WebView2（Chromium 内核）把侧键上报为 mousedown/auxclick 的 button 3/4，
// 其默认动作是 WebView2 自身的 GoBack/GoForward——本应用是 SPA、不产生
// webview 历史，默认等于无操作。此处 preventDefault 尽力拦截并接管为应用内
// 历史导航；个别 WebView2 版本若在事件到达页面前先行吞键，则退化为无操作
// （不产生副作用，已验证路径：常规桌面鼠标侧键走 WM_APPCOMMAND 前先派发
// DOM mousedown，本监听可捕获）。
import { useLayout } from "../stores/layout";
import { usePanes } from "../stores/panes";

export function installMouseNav(): () => void {
  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 3 && e.button !== 4) return;
    e.preventDefault();
    const pane = useLayout.getState().activePane();
    const tabId = pane?.tabs[pane.activeTab]?.id;
    if (!tabId) return;
    if (e.button === 3) usePanes.getState().back(tabId);
    else usePanes.getState().forward(tabId);
  };
  window.addEventListener("mousedown", onMouseDown);
  return () => window.removeEventListener("mousedown", onMouseDown);
}

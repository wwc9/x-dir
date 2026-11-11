// 屏蔽 WebView2 默认右键菜单（2026-11-11 用户反馈）：debug 构建开着 devtools，
// 应用未接管右键的区域（定制页/设置浮窗/对话框/列表空白处等）会弹出浏览器
// 调试菜单（返回/刷新/另存为/打印/检查）。各窗口入口挂载本拦截；文本编辑类
// 元素放行——原生编辑菜单（剪切/复制/粘贴/IME）在输入框内仍必要。应用自身
// 的右键菜单走 OLE 原生轨道与自绘浮层（pointer 事件驱动，全仓无 contextmenu
// 监听），本拦截对它们零影响。
export function suppressDefaultContextMenu(): void {
  window.addEventListener("contextmenu", (e) => {
    const el = e.target instanceof HTMLElement ? e.target : null;
    if (el && (el.closest("input, textarea") || el.isContentEditable)) return;
    e.preventDefault();
  });
}

// 屏蔽 WebView2 默认右键菜单（2026-11-11 用户反馈）：debug 构建开着 devtools，
// 应用未接管右键的区域（定制页/设置浮窗/对话框/列表空白处等）会弹出浏览器
// 调试菜单（返回/刷新/另存为/打印/检查）。各窗口入口挂载本拦截；文本编辑类
// 元素放行——原生编辑菜单（剪切/复制/粘贴/IME）在输入框内仍必要。应用自身
// 的右键菜单走 OLE 原生轨道与自绘浮层（pointer 事件驱动，全仓无 contextmenu
// 监听），本拦截对它们零影响。
//
// 文本选区放行「复制」（2026-11-23 用户需求「预览/关于等界面的文本要支持复制」）：
// 右键落在快速预览正文或对话框内的既有文本选区上时，交由主窗口注册的开启器
// 弹应用风格迷你菜单——右键复制是文本内容的第二惯例通道，此前一律屏蔽致该
// 场景无路可走。经注册器间接调用而非直连 stores/ui：shot/clip 轻量窗也挂载
// 本拦截（且永不出现 .np-dialog/.np-pv-body），直连会把主界面 stores 拉进
// 截图 bundle（shot.html 刻意不加载主界面依赖，§3.6 性能口径）。
export type TextCopyMenuOpener = (text: string, x: number, y: number) => void;

let textCopyMenuOpener: TextCopyMenuOpener | null = null;

/** 主窗口注册「文本选区右键复制」菜单开启器；shot/clip 窗不注册（行为不变） */
export function registerTextCopyMenu(opener: TextCopyMenuOpener | null): void {
  textCopyMenuOpener = opener;
}

export function suppressDefaultContextMenu(): void {
  window.addEventListener("contextmenu", (e) => {
    const el = e.target instanceof HTMLElement ? e.target : null;
    if (el && (el.closest("input, textarea") || el.isContentEditable)) return;
    // 选区文本先落变量再开菜单：点菜单项时的 mousedown 可能已折叠原生选区
    const sel = typeof window.getSelection === "function" ? window.getSelection() : null;
    const text = sel && sel.type === "Range" && !sel.isCollapsed ? sel.toString() : "";
    if (text && textCopyMenuOpener && el?.closest(".np-pv-body, .np-dialog")) {
      textCopyMenuOpener(text, e.clientX, e.clientY);
    }
    e.preventDefault();
  });
}

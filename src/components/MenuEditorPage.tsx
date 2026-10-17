// 定制（原「自定义」/创意工坊，2026-10-15 定名；顶栏魔棒钮唤起，占满顶栏以下内容区）：
// 壳层 = np-menupage（头部返回钮 + 内容滚动区，Esc 返回见 lib/shortcuts.ts），
// 头部布局与全盘搜索页一致（2026-10-16 定案）：返回钮 + 标题紧随其左。
// 内容 = MenuEditor（右键菜单 + 窗格工具栏双区拖拽，共享功能库）。
// 命令模板功能已下线（2026-10-14 定案），旧档模板数据留档不再渲染。
import { ArrowLeft } from "lucide-react";

import { DENSITY } from "../lib/tokens";
import { MenuEditor } from "./MenuEditor";
import { useUi } from "../stores/ui";
import { AppIcon } from "./AppIcon";

export function MenuEditorPage() {
  return (
    <section className="np-menupage">
      <header className="np-menupage-head">
        <button
          className="np-menupage-back"
          title="返回主界面（Esc）"
          onClick={() => useUi.getState().closeMenuPage()}
        >
          <AppIcon icon={ArrowLeft} size={DENSITY.iconSm} />
          <span>返回主界面</span>
        </button>
        <span className="np-menupage-title">定制</span>
      </header>
      <div className="np-menupage-body">
        <MenuEditor />
      </div>
    </section>
  );
}

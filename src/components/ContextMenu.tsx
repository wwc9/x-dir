import { Menu, MenuDivider, MenuItem } from "@blueprintjs/core";

import { DENSITY } from "../lib/tokens";
import { useUi, type MenuItem as UiMenuItem } from "../stores/ui";

function renderItems(items: UiMenuItem[], close: () => void) {
  return items.map((item, i) => {
    if (item.sep) return <MenuDivider key={i} />;
    return (
      <MenuItem
        key={i}
        text={item.label ?? ""}
        disabled={item.disabled}
        intent={item.danger ? "danger" : undefined}
        onClick={() => {
          if (item.sub) return;
          item.action?.();
          close();
        }}
      >
        {item.sub ? renderItems(item.sub, close) : undefined}
      </MenuItem>
    );
  });
}

/** 右键菜单：定位与关闭由 ui store 管理，渲染交给 Blueprint Menu（AGENTS.md 弹层规范） */
export function ContextMenu() {
  const menu = useUi((s) => s.menu);
  const close = useUi((s) => s.closeMenu);
  if (!menu) return null;

  // 钳制数值走 DENSITY（启发式估算，见 lib/tokens.ts 注释）
  const x = Math.min(menu.x, window.innerWidth - DENSITY.menuClampW);
  const y = Math.min(
    menu.y,
    window.innerHeight - menu.items.length * DENSITY.menuRowH - DENSITY.menuEdge,
  );

  return (
    <>
      <div
        className="fixed inset-0 z-30"
        onMouseDown={close}
        onContextMenu={(e) => {
          e.preventDefault();
          close();
        }}
      />
      <div className="fixed z-40" style={{ left: x, top: y }}>
        <Menu>{renderItems(menu.items, close)}</Menu>
      </div>
    </>
  );
}

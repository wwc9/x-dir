import { useState } from "react";
import { Button, Menu, MenuDivider, MenuItem, PopoverNext } from "@blueprintjs/core";
import { Check, ChevronDown } from "lucide-react";

import { ic } from "./AppIcon";

export interface NpSelectOption<T extends string | number> {
  value: T;
  label: string;
  title?: string;
  /** 禁用项不可选（如「出现位置」按功能能力位约束，AGENTS §4.3） */
  disabled?: boolean;
  /** 分隔线项（菜单分组用；该项不可选，value 仅作 key） */
  sep?: boolean;
}

/** 下拉选择（二级页面统一规范 AGENTS §4.7）：触发钮 = np-select 填充式按钮，
 *  弹层 = PopoverNext + Menu（surface 卡片，选中项 Check 标记）。
 *  禁用 HTMLSelect——原生下拉弹层是系统级渲染，CSS 无法样式化（2026-10-13 定案）；
 *  也不用 Blueprint Select——其内部是经典 Popover（React 19 下静默错位，项目已禁） */
export function NpSelect<T extends string | number>({
  value,
  options,
  onChange,
  title,
  className,
  popoverClassName,
}: {
  value: T;
  options: NpSelectOption<T>[];
  onChange(value: T): void;
  title?: string;
  className?: string;
  /** 透传 Menu className（弹层内容，点击目标祖先）：外点退出监听按此豁免弹层内点击 */
  popoverClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  return (
    <PopoverNext
      isOpen={open}
      onInteraction={setOpen}
      // bottom-end：菜单右缘对齐触发钮右缘、向左展开——值列下拉普遍贴所在
      // 界面（设置浮窗/参数对话框）右缘，bottom-start 会把宽菜单推出界面外
      // （2026-11-23 用户反馈「超过了设置界面的范围」）；视口级翻转仍由
      // Blueprint 自动处理（贴近视口左缘时翻回 bottom-start）
      placement="bottom-end"
      arrow={false}
      content={
        <Menu className={popoverClassName}>
          {options.map((o, i) =>
            o.sep ? (
              <MenuDivider key={`sep-${i}`} />
            ) : (
              <MenuItem
                key={String(o.value)}
                text={o.label}
                data-tip={o.title}
                disabled={o.disabled}
                active={o.value === value}
                labelElement={o.value === value ? ic(Check) : undefined}
                onClick={() => {
                  setOpen(false);
                  if (o.value !== value) onChange(o.value);
                }}
              />
            ),
          )}
        </Menu>
      }
    >
      <Button
        minimal
        size="small"
        className={`np-select${open ? " is-open" : ""}${className ? ` ${className}` : ""}`}
        data-tip={title}
        text={current?.label ?? ""}
        rightIcon={
          <span className="np-select-chev">{ic(ChevronDown)}</span>
        }
      />
    </PopoverNext>
  );
}

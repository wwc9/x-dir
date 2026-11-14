// 新建任务分类对话框（2026-11-14 用户反馈「分类支持自定义添加」）：
// 条目卡 / 定期任务编辑的分类下拉里的「＋ 新建分类…」唤起——名称 + 六色点，
// 保存即写入 settings.calendarCategories 并经 resolveDialog(新 id) 回传给
// 调用方直接选中（管理/改名/删除仍在 设置 → 日历）。
import { useState } from "react";
import { Button, DialogBody, DialogFooter, InputGroup } from "@blueprintjs/core";
import type { TagColor } from "../lib/ipc";

import { useT } from "../lib/i18n";
import { useSettings } from "../stores/settings";
import { useUi } from "../stores/ui";

const DOT_COLORS: { key: TagColor; label: string }[] = [
  { key: "red", label: "红" },
  { key: "orange", label: "橙" },
  { key: "yellow", label: "黄" },
  { key: "green", label: "绿" },
  { key: "blue", label: "蓝" },
  { key: "purple", label: "紫" },
];

export function CategoryNewDialog() {
  const t = useT();
  const [name, setName] = useState("");
  const [color, setColor] = useState<TagColor>("orange");

  const save = () => {
    if (!name.trim()) return;
    const id = `cat_${Date.now().toString(36)}`;
    const st = useSettings.getState();
    st.update({
      calendarCategories: [...st.calendarCategories, { id, name: name.trim(), color }],
    });
    useUi.getState().toast(t("分类已添加"));
    // 回传新分类 id 给调用方（条目/定期模板随即选中它），并关闭对话框
    useUi.getState().resolveDialog(id);
  };

  return (
    <>
      <DialogBody>
        <div className="np-bren-form is-cols">
          <div className="np-bren-field np-wide">
            <span className="np-bren-k">{t("分类名称")}</span>
            <span className="np-filext">
              <InputGroup
                small
                value={name}
                placeholder={t("例如：项目A / 学习 / 客户沟通")}
                spellCheck={false}
                onChange={(e) => setName(e.currentTarget.value)}
              />
            </span>
          </div>
          <div className="np-bren-field np-wide">
            <span className="np-bren-k">{t("颜色")}</span>
            <span className="np-cal-colordots">
              {DOT_COLORS.map((c) => (
                <button
                  key={c.key}
                  className={"np-cal-colordot" + (color === c.key ? " is-on" : "")}
                  style={{ background: `var(--np-tag-${c.key})` }}
                  data-tip={c.label}
                  aria-label={c.label}
                  onClick={() => setColor(c.key)}
                />
              ))}
            </span>
          </div>
        </div>
      </DialogBody>
      <DialogFooter
        actions={
          <>
            <Button size="small" onClick={() => useUi.getState().resolveDialog(null)}>
              {t("取消")}
            </Button>
            <Button size="small" intent="primary" disabled={!name.trim()} onClick={save}>
              {t("保存")}
            </Button>
          </>
        }
      />
    </>
  );
}

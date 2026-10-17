// 工具箱对话框（2026-10-17）：批量新建文件夹 / Excel 合并。
// 表单行复用 np-bren-form/field/k 基类、分段选择走 np-seg（Seg 自 ImgDialogs
// 导出共用）、预览行复用 np-bren-preview/row（§4.7 二级页面规范）；
// 编排（api + 任务登记）在 lib/operations.ts，名单预演纯函数在 lib/folderBatch。
import { useMemo, useState } from "react";
import { Button, DialogBody, DialogFooter, InputGroup } from "@blueprintjs/core";
import { ArrowRight } from "lucide-react";

import { FOLDER_BATCH_CAP, planFolders } from "../lib/folderBatch";
import { AppIcon } from "./AppIcon";
import { Seg } from "./ImgDialogs";
import { DENSITY } from "../lib/tokens";

function FormRow({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <span className="np-bren-field">
      <span className="np-bren-k">{k}</span>
      {children}
    </span>
  );
}

function Footer({
  okText,
  disabled,
  onOk,
  onCancel,
}: {
  okText: string;
  disabled?: boolean;
  onOk(): void;
  onCancel(): void;
}) {
  return (
    <DialogFooter
      actions={
        <>
          <Button size="small" onClick={onCancel}>
            取消
          </Button>
          <Button size="small" intent="primary" disabled={disabled} onClick={onOk}>
            {okText}
          </Button>
        </>
      }
    />
  );
}

/** 批量新建文件夹：多行名单 / 序号模板两种输入，实时预演最终名
 *  （与现有项重名自动 "(2)"，非法名与名单内重名红色标出） */
export function NewFoldersDialog({
  dir,
  existing,
  onDone,
}: {
  dir: string;
  existing: string[];
  onDone(names: string[] | null): void;
}) {
  const [mode, setMode] = useState<"lines" | "pattern">("lines");
  const [text, setText] = useState("");
  const [pattern, setPattern] = useState("第{}章");
  const [start, setStart] = useState(1);
  const [end, setEnd] = useState(10);
  const plan = useMemo(
    () => planFolders(mode, text, pattern, start, end, existing),
    [mode, text, pattern, start, end, existing],
  );
  const okNames = plan.filter((p) => p.name).map((p) => p.name as string);
  const errCount = plan.length - okNames.length;
  const num = (v: string, fb: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 9999) : fb;
  };
  return (
    <>
      <DialogBody>
        <div className="np-bren-form">
          <FormRow k="方式">
            <Seg<"lines" | "pattern">
              value={mode}
              onChange={setMode}
              options={[
                { value: "lines", label: "多行名单", title: "每行一个名称" },
                { value: "pattern", label: "序号模板", title: "{} 处按起止序号展开" },
              ]}
            />
          </FormRow>
        </div>
        {mode === "lines" ? (
          <textarea
            className="np-textarea"
            rows={7}
            value={text}
            placeholder={"每行一个文件夹名，如：\n项目立项\n需求评审\n开发阶段"}
            spellCheck={false}
            autoFocus
            onChange={(e) => setText(e.target.value)}
          />
        ) : (
          <div className="np-bren-form">
            <FormRow k="模板">
              <InputGroup
                size="small"
                value={pattern}
                placeholder="名称含 {} 占位符"
                spellCheck={false}
                onChange={(e) => setPattern(e.target.value)}
              />
            </FormRow>
            <FormRow k="起始">
              <InputGroup
                size="small"
                value={String(start)}
                spellCheck={false}
                onChange={(e) => setStart(num(e.target.value, start))}
              />
            </FormRow>
            <FormRow k="结束">
              <InputGroup
                size="small"
                value={String(end)}
                spellCheck={false}
                onChange={(e) => setEnd(num(e.target.value, end))}
              />
            </FormRow>
          </div>
        )}
        <div className="np-bren-preview">
          {plan.slice(0, 200).map((p, i) => (
            <div key={`${p.req}-${i}`} className="np-bren-row">
              <span className="np-bren-old np-ellipsis">{p.req}</span>
              <AppIcon
                icon={ArrowRight}
                size={DENSITY.iconXs}
                className="np-bren-arrow"
              />
              <span
                className={`np-bren-new np-ellipsis ${
                  p.error ? "is-err" : p.name === p.req ? "is-same" : "is-chg"
                }`}
              >
                {p.error ?? p.name}
              </span>
            </div>
          ))}
          {!plan.length && (
            <div className="np-bren-row is-same">
              <span className="np-bren-new is-same">
                {mode === "lines" ? "在上方输入名称名单" : "模板需含 {} 占位符"}
              </span>
            </div>
          )}
        </div>
        <div className="np-dialog-muted">
          将在 {dir} 下创建 {okNames.length} 个文件夹（与现有项重名时自动加序号）
          {errCount > 0 && `，${errCount} 项非法或重名（红色标出）`}
          {plan.length > 200 && "（仅预览前 200 行）"}
          {okNames.length >= FOLDER_BATCH_CAP && `，单次上限 ${FOLDER_BATCH_CAP} 个`}
        </div>
      </DialogBody>
      <Footer
        okText={`创建（${okNames.length} 项）`}
        disabled={!okNames.length}
        onOk={() => onDone(okNames)}
        onCancel={() => onDone(null)}
      />
    </>
  );
}

/** Excel 合并：模式（每源表一张目标表 / 纵向拼接去重复表头）+ 输出名一次成形 */
export function XlsxMergeDialog({
  count,
  onDone,
}: {
  count: number;
  onDone(v: { mode: "sheets" | "rows"; name: string } | null): void;
}) {
  const [mode, setMode] = useState<"sheets" | "rows">("sheets");
  const [name, setName] = useState("合并表格.xlsx");
  const valid = name.trim().length > 0;
  return (
    <>
      <DialogBody>
        <div className="np-bren-form">
          <FormRow k="方式">
            <Seg<"sheets" | "rows">
              value={mode}
              onChange={setMode}
              options={[
                { value: "sheets", label: "分表保留", title: "每个源工作表一张目标表" },
                { value: "rows", label: "纵向拼接", title: "全部行并入一张表，重复表头自动去除" },
              ]}
            />
          </FormRow>
          <FormRow k="输出名">
            <InputGroup
              size="small"
              value={name}
              spellCheck={false}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && valid)
                  onDone({ mode, name });
              }}
            />
          </FormRow>
        </div>
        <div className="np-dialog-muted">
          按当前顺序合并 {count} 个工作簿（xlsx/xlsm/xls/xlsb/ods 均可读，统一输出
          .xlsx），旁写新文件不覆盖原文件。
        </div>
      </DialogBody>
      <Footer
        okText="合并"
        disabled={!valid}
        onOk={() => onDone({ mode, name })}
        onCancel={() => onDone(null)}
      />
    </>
  );
}

// 目录分析对话框（右键：查找重复文件 / 空间分析 / 文件夹比较）：
// 扫描由后端异步命令完成（秒级），对话框内 loading → 结果；宽弹窗（§4.7 二级页面规范）。
import { useEffect, useState } from "react";
import { Button, Checkbox, DialogBody, DialogFooter } from "@blueprintjs/core";
import { ArrowLeft, LoaderCircle } from "lucide-react";

import {
  api,
  type CompareResult,
  type DirSizeEntry,
  type DupGroup,
  type EmptyScan,
} from "../lib/ipc";
import { formatSize } from "../lib/format";
import { fileNameOf, joinPath } from "../lib/path";
import { DENSITY } from "../lib/tokens";
import { deletePaths, transfer } from "../lib/operations";
import { AppIcon } from "./AppIcon";

function Loading({ text }: { text: string }) {
  return (
    <div className="np-pv-none">
      <span className="np-spin">
        <AppIcon icon={LoaderCircle} size={DENSITY.iconLg} />
      </span>
      {text}
    </div>
  );
}

/** 重复文件：按组展示，默认勾选每组除首份外的副本；删除走回收站 */
export function DuplicateDialog({ dir, onDone }: { dir: string; onDone(): void }) {
  const [groups, setGroups] = useState<DupGroup[] | null>(null);
  const [error, setError] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());

  useEffect(() => {
    let live = true;
    api.findDuplicates(dir).then(
      (gs) => {
        if (!live) return;
        setGroups(gs);
        // 默认保留每组第一份（按路径排序后），其余副本入选删除清单
        const s = new Set<string>();
        for (const g of gs) g.paths.slice(1).forEach((p) => s.add(p));
        setSel(s);
      },
      (e) => live && setError(String(e)),
    );
    return () => {
      live = false;
    };
  }, [dir]);

  const toggle = (p: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });

  const del = () => {
    const paths = [...sel];
    onDone();
    if (paths.length) void deletePaths(paths, false); // 弹窗内已确认，跳过二次确认
  };

  return (
    <>
      <DialogBody>
        {error ? (
          <div className="np-list-error">扫描失败：{error}</div>
        ) : !groups ? (
          <Loading text="正在按内容指纹扫描…" />
        ) : !groups.length ? (
          <div className="np-list-empty">没有发现重复文件</div>
        ) : (
          <div className="np-dup-list">
            <div className="np-dialog-muted">
              共 {groups.length} 组重复，勾选要清理的副本（默认保留每组第一份）
            </div>
            {groups.map((g) => (
              <div key={g.hash}>
                <div className="np-dup-head">
                  <span>{formatSize({ isDir: false, size: g.size })}</span>
                  <span className="np-cell-muted">
                    × {g.paths.length} 份 · 可省{" "}
                    {formatSize({ isDir: false, size: g.size * (g.paths.length - 1) })}
                  </span>
                </div>
                {g.paths.map((p) => (
                  <Checkbox
                    key={p}
                    className="np-dup-row"
                    checked={sel.has(p)}
                    onChange={() => toggle(p)}
                    labelElement={
                      <span className="np-ellipsis" title={p}>
                        {fileNameOf(p)}
                        <span className="np-cell-muted"> · {p}</span>
                      </span>
                    }
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </DialogBody>
      <DialogFooter
        actions={
          <>
            <Button size="small" onClick={onDone}>
              关闭
            </Button>
            <Button size="small" intent="danger" disabled={!sel.size} onClick={del}>
              删除选中（回收站）
            </Button>
          </>
        }
      />
    </>
  );
}

/** 空文件/空文件夹清理：分两组展示（默认全选），删除走回收站；
 *  空文件夹只列字面空目录（只含空子目录的父目录不算），整组勾选不会误删内容 */
export function EmptyScanDialog({ dir, onDone }: { dir: string; onDone(): void }) {
  const [scan, setScan] = useState<EmptyScan | null>(null);
  const [error, setError] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());

  useEffect(() => {
    let live = true;
    api.scanEmpty(dir).then(
      (r) => {
        if (!live) return;
        setScan(r);
        setSel(new Set([...r.emptyFiles, ...r.emptyDirs]));
      },
      (e) => live && setError(String(e)),
    );
    return () => {
      live = false;
    };
  }, [dir]);

  const toggle = (p: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });

  const del = () => {
    const paths = [...sel];
    onDone();
    if (paths.length) void deletePaths(paths, false); // 弹窗内已确认，跳过二次确认
  };

  const section = (title: string, paths: string[]) =>
    paths.length > 0 && (
      <div>
        <div className="np-dup-head">
          <span>{title}</span>
          <span className="np-cell-muted">{paths.length} 项</span>
        </div>
        {paths.map((p) => (
          <Checkbox
            key={p}
            className="np-dup-row"
            checked={sel.has(p)}
            onChange={() => toggle(p)}
            labelElement={
              <span className="np-ellipsis" title={p}>
                {fileNameOf(p)}
                <span className="np-cell-muted">
                  {" "}
                  · {p.slice(dir.length + 1) || p}
                </span>
              </span>
            }
          />
        ))}
      </div>
    );

  const total = (scan?.emptyFiles.length ?? 0) + (scan?.emptyDirs.length ?? 0);

  return (
    <>
      <DialogBody>
        {error ? (
          <div className="np-list-error">扫描失败：{error}</div>
        ) : !scan ? (
          <Loading text="正在扫描空文件与空文件夹…" />
        ) : !total ? (
          <div className="np-list-empty">没有发现空文件或空文件夹</div>
        ) : (
          <div className="np-dup-list">
            <div className="np-dialog-muted">
              共扫描 {scan.scanned} 项，勾选要清理的 {sel.size} 项（删除到回收站）
            </div>
            {section("空文件（0 字节）", scan.emptyFiles)}
            {section("空文件夹", scan.emptyDirs)}
          </div>
        )}
      </DialogBody>
      <DialogFooter
        actions={
          <>
            <Button size="small" onClick={onDone}>
              关闭
            </Button>
            <Button
              size="small"
              intent="danger"
              disabled={!sel.size}
              onClick={del}
            >
              删除选中（回收站）
            </Button>
          </>
        }
      />
    </>
  );
}

/** 空间分析：直接子项体积条（文件夹递归合计），点文件夹逐层钻取 */
export function DirSizeDialog({ dir, onDone }: { dir: string; onDone(): void }) {
  const [cwd, setCwd] = useState(dir);
  const [stack, setStack] = useState<string[]>([]);
  const [rows, setRows] = useState<DirSizeEntry[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    setRows(null);
    setError("");
    api.dirSizes(cwd).then(
      (r) => live && setRows(r),
      (e) => live && setError(String(e)),
    );
    return () => {
      live = false;
    };
  }, [cwd]);

  const max = rows?.[0]?.size ?? 0;
  const drill = (p: string) => {
    setStack((s) => [...s, cwd]);
    setCwd(p);
  };
  const back = () =>
    setStack((s) => {
      const n = [...s];
      setCwd(n.pop() ?? dir);
      return n;
    });

  return (
    <>
      <DialogBody>
        <div className="np-dsiz-head">
          {stack.length > 0 && (
            <button className="np-dsiz-back" title="上一级" onClick={back}>
              <AppIcon icon={ArrowLeft} size={DENSITY.iconSm} />
            </button>
          )}
          <span className="np-ellipsis" title={cwd}>
            {fileNameOf(cwd) || cwd}
          </span>
        </div>
        {error ? (
          <div className="np-list-error">扫描失败：{error}</div>
        ) : !rows ? (
          <Loading text="正在统计目录体积…" />
        ) : !rows.length ? (
          <div className="np-list-empty">空目录</div>
        ) : (
          <div className="np-dsiz-list">
            {rows.map((r) => (
              <div
                key={r.path}
                className="np-dsiz-row"
                onClick={() => r.isDir && drill(r.path)}
                title={r.isDir ? "查看子目录体积" : undefined}
              >
                <span
                  className={`np-dsiz-name np-ellipsis${r.isDir ? " is-dir" : ""}`}
                >
                  {r.name}
                </span>
                <span className="np-dsiz-bar">
                  <span
                    style={{ width: max ? `${(r.size / max) * 100}%` : "0%" }}
                  />
                </span>
                <span className="np-cell-muted np-dsiz-files">
                  {r.isDir ? `${r.files} 项` : ""}
                </span>
                <span className="np-dsiz-size">
                  {formatSize({ isDir: r.isDir, size: r.size })}
                </span>
              </div>
            ))}
          </div>
        )}
      </DialogBody>
      <DialogFooter
        actions={
          <Button size="small" onClick={onDone}>
            关闭
          </Button>
        }
      />
    </>
  );
}

/** 文件夹比较：三段差异清单（A 独有 / B 独有 / 内容不同），按方向选择性复制同步 */
export function CompareDialog({
  a,
  b,
  onDone,
}: {
  a: string;
  b: string;
  onDone(): void;
}) {
  const [res, setRes] = useState<CompareResult | null>(null);
  const [error, setError] = useState("");
  // A→B = aOnly + differ（取 A 版本覆盖）；B→A = bOnly
  const [selA, setSelA] = useState<Set<string>>(new Set());
  const [selB, setSelB] = useState<Set<string>>(new Set());

  useEffect(() => {
    let live = true;
    api.compareDirs(a, b).then(
      (r) => {
        if (!live) return;
        setRes(r);
        setSelA(new Set([...r.aOnly, ...r.differ].map((i) => i.rel)));
        setSelB(new Set(r.bOnly.map((i) => i.rel)));
      },
      (e) => live && setError(String(e)),
    );
    return () => {
      live = false;
    };
  }, [a, b]);

  const toggle = (side: "a" | "b", rel: string) => {
    const setter = side === "a" ? setSelA : setSelB;
    setter((s) => {
      const n = new Set(s);
      if (n.has(rel)) n.delete(rel);
      else n.add(rel);
      return n;
    });
  };

  const syncTo = (from: "a" | "b") => {
    if (!res) return;
    const root = from === "a" ? a : b;
    const dest = from === "a" ? b : a;
    const sel = from === "a" ? selA : selB;
    const pool = from === "a" ? [...res.aOnly, ...res.differ] : res.bOnly;
    const sources = pool
      .filter((i) => sel.has(i.rel))
      .map((i) => joinPath(root, i.rel));
    onDone();
    if (sources.length) void transfer(sources, dest, "copy");
  };

  const section = (
    title: string,
    side: "a" | "b",
    items: { rel: string; size: number }[],
    sel: Set<string>,
  ) =>
    items.length > 0 && (
      <div>
        <div className="np-dup-head">
          <span>{title}</span>
          <span className="np-cell-muted">{items.length} 项</span>
        </div>
        {items.map((i) => (
          <Checkbox
            key={i.rel}
            className="np-dup-row"
            checked={sel.has(i.rel)}
            onChange={() => toggle(side, i.rel)}
            labelElement={
              <span className="np-ellipsis" title={i.rel}>
                {i.rel}
                <span className="np-cell-muted">
                  {" "}
                  · {formatSize({ isDir: false, size: i.size })}
                </span>
              </span>
            }
          />
        ))}
      </div>
    );

  const aName = fileNameOf(a) || a;
  const bName = fileNameOf(b) || b;

  return (
    <>
      <DialogBody>
        {error ? (
          <div className="np-list-error">比较失败：{error}</div>
        ) : !res ? (
          <Loading text="正在比较两个文件夹…" />
        ) : (
          <>
            <div className="np-dialog-muted">
              {aName} ↔ {bName} · {res.same} 项一致
            </div>
            <div className="np-cmp-list">
              {section(`仅在 ${aName}`, "a", res.aOnly, selA)}
              {section(`仅在 ${bName}`, "b", res.bOnly, selB)}
              {section("内容不同（复制时以左侧版本为准）", "a", res.differ, selA)}
              {!res.aOnly.length && !res.bOnly.length && !res.differ.length && (
                <div className="np-list-empty">两个文件夹内容一致</div>
              )}
            </div>
          </>
        )}
      </DialogBody>
      <DialogFooter
        actions={
          <>
            <Button size="small" onClick={onDone}>
              关闭
            </Button>
            <Button
              size="small"
              disabled={!selB.size}
              onClick={() => syncTo("b")}
              title={`把勾选的 ${selB.size} 项从 ${bName} 复制到 ${aName}`}
            >
              {bName} → {aName}
            </Button>
            <Button
              size="small"
              intent="primary"
              disabled={!selA.size}
              onClick={() => syncTo("a")}
              title={`把勾选的 ${selA.size} 项从 ${aName} 复制到 ${bName}`}
            >
              {aName} → {bName}
            </Button>
          </>
        }
      />
    </>
  );
}

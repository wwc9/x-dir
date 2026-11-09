// 目录分析对话框（右键：查找重复文件 / 空间分析 / 文件夹比较）：
// 扫描由后端异步命令完成（秒级），对话框内 loading → 结果；宽弹窗（§4.7 二级页面规范）。
import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../lib/i18n";
import { Button, Checkbox, DialogBody, DialogFooter } from "@blueprintjs/core";
import { ArrowLeft, LoaderCircle } from "lucide-react";

import {
  api,
  type CompareResult,
  type DirSizeEntry,
  type DupGroup,
  type EmptyScan,
} from "../lib/ipc";
import { formatBytes } from "../lib/format";
import { fileIcon } from "../lib/fileIcons";
import { extColorCat, treemap } from "../lib/treemap";
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
          <Loading text={t("正在按内容指纹扫描…")} />
        ) : !groups.length ? (
          <div className="np-list-empty">{t("没有发现重复文件")}</div>
        ) : (
          <div className="np-dup-list">
            <div className="np-dialog-muted">
              共 {groups.length} 组重复，勾选要清理的副本（默认保留每组第一份）
            </div>
            {groups.map((g) => (
              <div key={g.hash}>
                <div className="np-dup-head">
                  <span>{formatBytes(g.size)}</span>
                  <span className="np-cell-muted">
                    × {g.paths.length} 份 · 可省{" "}
                    {formatBytes(g.size * (g.paths.length - 1))}
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
              {t("关闭")}
            </Button>
            <Button size="small" intent="danger" disabled={!sel.size} onClick={del}>
              {t("删除选中（回收站）")}
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
          <Loading text={t("正在扫描空文件与空文件夹…")} />
        ) : !total ? (
          <div className="np-list-empty">{t("没有发现空文件或空文件夹")}</div>
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
              {t("关闭")}
            </Button>
            <Button
              size="small"
              intent="danger"
              disabled={!sel.size}
              onClick={del}
            >
              {t("删除选中（回收站）")}
            </Button>
          </>
        }
      />
    </>
  );
}

/** 空间分析（2026-11-09 WizTree 式改版）：上矩形树图（squarified 布局，面积
 *  ∝ 体积、--np-icon-* 类型着色；点击文件夹色块下钻、点击文件色块选中）+
 *  下体积清单（勾选文件/文件夹，删除到回收站）；逐层钻取与面包屑栈沿用 */
export function DirSizeDialog({ dir, onDone }: { dir: string; onDone(): void }) {
  const [cwd, setCwd] = useState(dir);
  const [stack, setStack] = useState<string[]>([]);
  const [rows, setRows] = useState<DirSizeEntry[] | null>(null);
  const [error, setError] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const tmRef = useRef<HTMLDivElement | null>(null);
  const [tmBox, setTmBox] = useState({ w: 0, h: 0 });

  useEffect(() => {
    let live = true;
    setRows(null);
    setError("");
    setSel(new Set());
    api.dirSizes(cwd).then(
      (r) => live && setRows(r),
      (e) => live && setError(String(e)),
    );
    return () => {
      live = false;
    };
  }, [cwd]);

  // 容器测量 → 树图布局（宽随弹窗、高固定 240，见 np-dsiz-tm）
  useEffect(() => {
    const el = tmRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() =>
      setTmBox({ w: el.clientWidth, h: el.clientHeight }),
    );
    ro.observe(el);
    setTmBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const rects = useMemo(
    () =>
      treemap(
        (rows ?? []).map((r) => ({ key: r.path, size: r.size })),
        tmBox.w,
        tmBox.h,
      ),
    [rows, tmBox],
  );
  const byPath = useMemo(
    () => new Map((rows ?? []).map((r) => [r.path, r])),
    [rows],
  );
  const total = useMemo(() => (rows ?? []).reduce((s, r) => s + r.size, 0), [rows]);

  const toggle = (p: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });
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
  const del = () => {
    const paths = [...sel];
    onDone();
    if (paths.length) void deletePaths(paths, false); // 弹窗内已确认，跳过二次确认
  };

  return (
    <>
      <DialogBody>
        <div className="np-dsiz-head">
          {stack.length > 0 && (
            <button className="np-dsiz-back" data-tip={t("返回上一级")} onClick={back}>
              <AppIcon icon={ArrowLeft} size={DENSITY.iconSm} />
            </button>
          )}
          <span className="np-ellipsis" title={cwd}>
            {fileNameOf(cwd) || cwd}
          </span>
          {rows && (
            <span className="np-cell-muted np-dsiz-total">
              {t("合计 {size} · {n} 项", {
                size: formatBytes(total),
                n: rows.length,
              })}
            </span>
          )}
        </div>
        <div className="np-dsiz-tm" ref={tmRef}>
          {error ? (
            <div className="np-list-error">{t("扫描失败：")}{error}</div>
          ) : !rows ? (
            <Loading text={t("正在统计目录体积…")} />
          ) : !rects.length ? (
            <div className="np-dialog-muted np-dsiz-tmempty">
              {rows.length
                ? t("全部条目均为 0 字节，不占色块，可在下方列表勾选删除")
                : t("空目录")}
            </div>
          ) : (
            rects.map((rc) => {
              const r = byPath.get(rc.key);
              if (!r) return null;
              const cat = extColorCat(r.name, r.isDir);
              const size = formatBytes(r.size);
              // 浓淡随体积占比（2026-11-09 用户需求）：sqrt 压缩动态范围，
              // 大项深、小项浅——背景 10–65%、描边 30–70% 两档线性映射
              const conc = Math.sqrt(total > 0 ? r.size / total : 0);
              const showName = rc.w >= 72 && rc.h >= 24;
              const showSize = rc.w >= 72 && rc.h >= 46;
              return (
                <div
                  key={rc.key}
                  className={`np-dsiz-cell${r.isDir ? " is-dir" : ""}${
                    sel.has(rc.key) ? " is-sel" : ""
                  }`}
                  data-cat={cat}
                  style={{
                    left: rc.x,
                    top: rc.y,
                    width: rc.w,
                    height: rc.h,
                    "--tm-bg": `${10 + Math.round(conc * 55)}%`,
                    "--tm-bd": `${30 + Math.round(conc * 40)}%`,
                  } as React.CSSProperties}
                  data-tip={`${r.name} · ${size}${r.isDir ? ` · ${t("{n} 项", { n: r.files })}` : ""}`}
                  onClick={() => (r.isDir ? drill(r.path) : toggle(r.path))}
                >
                  {showName && (
                    <span className="np-dsiz-cellname np-ellipsis">{r.name}</span>
                  )}
                  {showSize && (
                    <span className="np-dsiz-cellsize">{size}</span>
                  )}
                </div>
              );
            })
          )}
        </div>
        {error ? null : rows && rows.length > 0 && (
          <div className="np-dialog-muted np-dsiz-hint">
            {t("点击文件夹色块逐层下钻；勾选文件或文件夹后删除到回收站")}
          </div>
        )}
        {!error && rows && rows.length > 0 && (
          <div className="np-dsiz-list">
            {rows.map((r) => {
              const spec = fileIcon(r.name, r.isDir);
              return (
                <div
                  key={r.path}
                  className="np-dsiz-row"
                  onClick={() => (r.isDir ? drill(r.path) : toggle(r.path))}
                  data-tip={r.isDir ? "查看子目录体积" : undefined}
                >
                  <span
                    className="np-dsiz-ck"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(r.path);
                    }}
                  >
                    <Checkbox
                      checked={sel.has(r.path)}
                      onChange={() => toggle(r.path)}
                    />
                  </span>
                  <span className="np-dsiz-ic">
                    <AppIcon
                      icon={spec.icon}
                      size={DENSITY.iconSm}
                      colorVar={spec.colorVar}
                    />
                  </span>
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
                  <span className="np-cell-muted np-dsiz-pct">
                    {total > 0 ? `${((r.size / total) * 100).toFixed(1)}%` : "—"}
                  </span>
                  <span className="np-dsiz-size">
                    {formatBytes(r.size)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </DialogBody>
      <DialogFooter
        actions={
          <>
            <Button size="small" onClick={onDone}>
              {t("关闭")}
            </Button>
            <Button
              size="small"
              intent="danger"
              disabled={!sel.size}
              onClick={del}
            >
              {t("删除选中（回收站）")}
            </Button>
          </>
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
                  · {formatBytes(i.size)}
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
          <Loading text={t("正在比较两个文件夹…")} />
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
                <div className="np-list-empty">{t("两个文件夹内容一致")}</div>
              )}
            </div>
          </>
        )}
      </DialogBody>
      <DialogFooter
        actions={
          <>
            <Button size="small" onClick={onDone}>
              {t("关闭")}
            </Button>
            <Button
              size="small"
              disabled={!selB.size}
              onClick={() => syncTo("b")}
              data-tip={`把勾选的 ${selB.size} 项从 ${bName} 复制到 ${aName}`}
            >
              {bName} → {aName}
            </Button>
            <Button
              size="small"
              intent="primary"
              disabled={!selA.size}
              onClick={() => syncTo("a")}
              data-tip={`把勾选的 ${selA.size} 项从 ${aName} 复制到 ${bName}`}
            >
              {aName} → {bName}
            </Button>
          </>
        }
      />
    </>
  );
}

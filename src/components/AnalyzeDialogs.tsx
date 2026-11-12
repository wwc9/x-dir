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
import { buildDupCsv, dupWaste } from "../lib/listing";
import { extOf, fileIcon } from "../lib/fileIcons";
import { treemap } from "../lib/treemap";
import { fileNameOf, joinPath } from "../lib/path";
import { DENSITY } from "../lib/tokens";
import { deletePaths, transfer } from "../lib/operations";
import { confirmDialog, useUi } from "../stores/ui";
import { useIcons } from "../stores/icons";
import { useSettings } from "../stores/settings";
import { AppIcon } from "./AppIcon";

/** 真实图标（realIcons 开启）：Rust 提取的位图 dataURL 淡入，np-icon-slot
 *  预留位保行高（同 FileList FadeInIcon 口径，本地轻量副本免跨组件引用） */
function RealIcon({ src }: { src: string }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setOn(true));
    return () => cancelAnimationFrame(id);
  }, [src]);
  return (
    <span className="np-icon-slot">
      <img
        className="np-realicon"
        src={src}
        alt=""
        draggable={false}
        style={{ opacity: on ? 1 : 0 }}
      />
    </span>
  );
}

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

/** 重复文件：按组展示，默认勾选每组除首份外的副本；删除走回收站；
 *  头部统计组数与可释放空间（2026-11-09 增强），清单可导出 CSV 审计留档 */
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

  const exportCsv = () => {
    if (!groups) return;
    void (async () => {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const target = await save({
        defaultPath: joinPath(dir, t("重复文件清单.csv")),
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!target) return;
      try {
        await api.saveTextFile(target, buildDupCsv(groups));
        useUi.getState().toast(t("重复文件清单已导出"));
      } catch (e) {
        useUi.getState().toast(t("导出失败：{msg}", { msg: String(e) }), "error");
      }
    })();
  };

  return (
    <>
      <DialogBody>
        {error ? (
          <div className="np-list-error">{t("扫描失败：")}{error}</div>
        ) : !groups ? (
          <Loading text={t("正在按内容指纹扫描…")} />
        ) : !groups.length ? (
          <div className="np-list-empty">{t("没有发现重复文件")}</div>
        ) : (
          <div className="np-dup-list">
            <div className="np-dialog-muted">
              {t("共 {n} 组重复 · 可释放 {size}", {
                n: groups.length,
                size: formatBytes(dupWaste(groups)),
              })}
              {t("，勾选要清理的副本（默认保留每组第一份）")}
            </div>
            {groups.map((g) => (
              <div key={g.hash}>
                <div className="np-dup-head">
                  <span>{formatBytes(g.size)}</span>
                  <span className="np-cell-muted">
                    {t("× {n} 份 · 可省", { n: g.paths.length })}{" "}
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
            <Button size="small" disabled={!groups?.length} onClick={exportCsv}>
              {t("导出清单")}
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
          <span className="np-cell-muted">{t("{n} 项", { n: paths.length })}</span>
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
          <div className="np-list-error">{t("扫描失败：")}{error}</div>
        ) : !scan ? (
          <Loading text={t("正在扫描空文件与空文件夹…")} />
        ) : !total ? (
          <div className="np-list-empty">{t("没有发现空文件或空文件夹")}</div>
        ) : (
          <div className="np-dup-list">
            <div className="np-dialog-muted">
              {t("共扫描 {total} 项，勾选要清理的 {selected} 项（删除到回收站）", {
                total: scan.scanned,
                selected: sel.size,
              })}
            </div>
            {section(t("空文件（0 字节）"), scan.emptyFiles)}
            {section(t("空文件夹"), scan.emptyDirs)}
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
 *  ∝ 体积、主题蓝浓淡随占比分级；点击文件夹色块下钻、点击文件色块选中）+
 *  下体积清单（类型图标跟随「真实图标」设置；勾选文件/文件夹，删除到回收站）；
 *  逐层钻取与面包屑栈沿用 */
export function DirSizeDialog({ dir, onDone }: { dir: string; onDone(): void }) {
  const [cwd, setCwd] = useState(dir);
  const [stack, setStack] = useState<string[]>([]);
  const [rows, setRows] = useState<DirSizeEntry[] | null>(null);
  const [error, setError] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const tmRef = useRef<HTMLDivElement | null>(null);
  const [tmBox, setTmBox] = useState({ w: 0, h: 0 });
  const realIcons = useSettings((s) => s.realIcons);
  const iconMap = useIcons((s) => s.icons);
  const extMap = useIcons((s) => s.exts);

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

  // 真实图标（realIcons 开启）：按可见清单批量请求（路径表优先、扩展名共享表
  // 直渲染，miss 负缓存——同 FileList 机制）
  useEffect(() => {
    if (!realIcons || !rows?.length) return;
    useIcons.getState().requestIcons(rows.map((r) => r.path));
  }, [realIcons, rows]);

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
              const size = formatBytes(r.size);
              // 浓淡随体积占比（sqrt 压缩动态范围）：
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
              // 图标跟随「真实图标」设置：开 = Rust 提取位图（路径表/扩展名共享表，
              // 同文件列表口径）；关 = Lucide 语义色图标
              const real =
                iconMap[r.path] ?? extMap[extOf(r.name)] ?? undefined;
              const spec = fileIcon(r.name, r.isDir);
              return (
                <div
                  key={r.path}
                  className="np-dsiz-row"
                  onClick={() => (r.isDir ? drill(r.path) : toggle(r.path))}
                  data-tip={r.isDir ? t("查看子目录体积") : undefined}
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
                    {realIcons ? (
                      real ? (
                        <RealIcon src={real} />
                      ) : (
                        // 真实图标模式下 Lucide 不参与（用户预期「全部用真实图标」，
                        // miss 槽位保行高——同 FileList 口径）
                        <span className="np-icon-slot" />
                      )
                    ) : (
                      <AppIcon
                        icon={spec.icon}
                        size={DENSITY.iconSm}
                        colorVar={spec.colorVar}
                      />
                    )}
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
                    {r.isDir ? t("{n} 项", { n: r.files }) : ""}
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

/** 文件夹比较：三段差异清单（A 独有 / B 独有 / 内容不同），按方向选择性复制同步；
 *  「内容不同」段独立勾选（2026-11-09 增强：任一方向都可带走，以勾选侧版本为准），
 *  另提供「删除右侧多余」回收站动作补齐 TC Synchronize Dirs 的复制/删除两动作 */
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
  // A→B = aOnly + differ（取 A 版本覆盖）；B→A = bOnly + differ（取 B 版本覆盖）
  const [selA, setSelA] = useState<Set<string>>(new Set());
  const [selB, setSelB] = useState<Set<string>>(new Set());
  const [selD, setSelD] = useState<Set<string>>(new Set());

  useEffect(() => {
    let live = true;
    api.compareDirs(a, b).then(
      (r) => {
        if (!live) return;
        setRes(r);
        setSelA(new Set(r.aOnly.map((i) => i.rel)));
        setSelB(new Set(r.bOnly.map((i) => i.rel)));
        setSelD(new Set(r.differ.map((i) => i.rel)));
      },
      (e) => live && setError(String(e)),
    );
    return () => {
      live = false;
    };
  }, [a, b]);

  const toggle = (side: "a" | "b" | "d", rel: string) => {
    const setter = side === "a" ? setSelA : side === "b" ? setSelB : setSelD;
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
    const own = from === "a" ? selA : selB;
    const pool = from === "a" ? res.aOnly : res.bOnly;
    const sources = [
      ...pool.filter((i) => own.has(i.rel)),
      ...res.differ.filter((i) => selD.has(i.rel)),
    ].map((i) => joinPath(root, i.rel));
    onDone();
    if (sources.length) void transfer(sources, dest, "copy");
  };

  /** 删除「仅在 B」勾选项（回收站）：补齐同步闭环的另一动作——以 A 为准清理
   *  B 侧多余；弹窗勾选即意图，确认弹窗复核一次（删除类动作口径） */
  const deleteBOnly = () => {
    if (!res) return;
    const paths = res.bOnly
      .filter((i) => selB.has(i.rel))
      .map((i) => joinPath(b, i.rel));
    void confirmDialog({
      title: t("删除多余项"),
      message: t("把「仅在 {name}」勾选的 {n} 项移入回收站？", {
        name: fileNameOf(b) || b,
        n: paths.length,
      }),
      kind: "danger",
      okText: t("删除"),
    }).then((ok) => {
      if (!ok) return;
      onDone();
      if (paths.length) void deletePaths(paths, false); // 已复核，跳过二次确认
    });
  };

  const section = (
    title: string,
    side: "a" | "b" | "d",
    items: { rel: string; size: number }[],
    sel: Set<string>,
  ) =>
    items.length > 0 && (
      <div>
        <div className="np-dup-head">
          <span>{title}</span>
          <span className="np-cell-muted">{t("{n} 项", { n: items.length })}</span>
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
          <div className="np-list-error">{t("比较失败：")}{error}</div>
        ) : !res ? (
          <Loading text={t("正在比较两个文件夹…")} />
        ) : (
          <>
            <div className="np-dialog-muted">
              {t("{a} ↔ {b} · {n} 项一致", { a: aName, b: bName, n: res.same })}
            </div>
            <div className="np-cmp-list">
              {section(t("仅在 {name}", { name: aName }), "a", res.aOnly, selA)}
              {section(t("仅在 {name}", { name: bName }), "b", res.bOnly, selB)}
              {section(
                t("内容不同（复制方向决定以哪侧版本为准）"),
                "d",
                res.differ,
                selD,
              )}
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
              intent="danger"
              disabled={!selB.size}
              onClick={deleteBOnly}
              data-tip={t("把「仅在 {name}」勾选的 {n} 项移入回收站", {
                name: bName,
                n: selB.size,
              })}
            >
              {t("删除 {name} 多余", { name: bName })}
            </Button>
            <Button
              size="small"
              disabled={!selB.size && !selD.size}
              onClick={() => syncTo("b")}
              data-tip={t("把勾选的 {n} 项以 {from} 版本复制到 {to}", {
                n: selB.size + selD.size,
                from: bName,
                to: aName,
              })}
            >
              {bName} → {aName}
            </Button>
            <Button
              size="small"
              intent="primary"
              disabled={!selA.size && !selD.size}
              onClick={() => syncTo("a")}
              data-tip={t("把勾选的 {n} 项以 {from} 版本复制到 {to}", {
                n: selA.size + selD.size,
                from: aName,
                to: bName,
              })}
            >
              {aName} → {bName}
            </Button>
          </>
        }
      />
    </>
  );
}

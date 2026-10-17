// 索引模式（NTFS 秒搜）控件：状态轮询 hook + 状态条控制组（chip + 常驻开关）+ 进度弹层。
// 2026-10-16 从设置面板移入全盘搜索界面（AGENTS §4.3）；开关打开即弹出建立进度，
// 阶段归约在 lib/indexPhase.ts（纯函数配单测），完成/失败经灵动岛回执播报。
// 开启 = UAC 拉起提权守护（一次授权，后台常驻）；关闭 = 写停止文件优雅退出。
import { useEffect, useRef, useState } from "react";
import { PopoverNext, Switch } from "@blueprintjs/core";
import { Check, LoaderCircle, X } from "lucide-react";

import { api, type IndexStatus } from "../lib/ipc";
import {
  analyzeIndexPhase,
  errorSummary,
  readySummary,
  type IndexPhase,
} from "../lib/indexPhase";
import { DENSITY } from "../lib/tokens";
import { useSettings } from "../stores/settings";
import { useUi } from "../stores/ui";
import { AppIcon } from "./AppIcon";

/** 索引状态轮询：active 期间 2s 一次（index_status 读本地状态文件，开销可忽略） */
export function useIndexStatus(active: boolean): IndexStatus | null {
  const [status, setStatus] = useState<IndexStatus | null>(null);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const tick = () =>
      api
        .indexStatus()
        .then((s) => {
          if (alive) setStatus(s);
        })
        .catch(() => undefined);
    tick();
    const t = window.setInterval(tick, 2000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [active]);
  return status;
}

/** 开关流程：先落偏好再调命令，失败回滚并提示；onOk = 开启成功后的回调（弹进度层） */
function toggleIndexMode(enabled: boolean, onToggle: (v: boolean) => void, onOk?: () => void) {
  onToggle(enabled);
  if (enabled) {
    api
      .enableIndexMode()
      .then(() => {
        useUi.getState().toast("已拉起索引守护进程，后台建索引中…");
        onOk?.();
      })
      .catch((e) => {
        useUi.getState().toast(`开启索引模式失败：${String(e)}`, "error");
        onToggle(false);
      });
  } else {
    api
      .disableIndexMode()
      .then(() => useUi.getState().toast("已发送停止请求，守护进程保存索引后退出"))
      .catch((e) => {
        // 与开启分支对称：失败必须提示并回滚开关，不能吞成 unhandledrejection
        useUi.getState().toast(`关闭索引模式失败：${String(e)}`, "error");
        onToggle(true);
      });
  }
}

const PHASE_LABEL: Record<IndexPhase, string> = {
  off: "索引模式",
  starting: "启动中…",
  building: "建索引中",
  ready: "索引模式",
  error: "索引错误",
  down: "守护离线",
};

/** 各卷进度行：状态小图标 + 盘符 + 条目数/错误 */
function VolumeRows({
  vols,
}: {
  vols: ReturnType<typeof analyzeIndexPhase>["vols"];
}) {
  if (!vols.length) return null;
  return (
    <div className="np-gsearch-idx-vols">
      {vols.map((v) => (
        <span key={v.letter} className="np-gsearch-idx-vol">
          {v.state === "building" ? (
            <span className="np-spin">
              <AppIcon icon={LoaderCircle} size={DENSITY.iconXs} />
            </span>
          ) : v.state === "error" ? (
            <AppIcon icon={X} size={DENSITY.iconXs} colorVar="--np-danger" />
          ) : (
            <AppIcon icon={Check} size={DENSITY.iconXs} colorVar="--np-accent" />
          )}
          <span className="np-gsearch-idx-vol-letter">{v.letter}:</span>
          <span className="np-gsearch-idx-vol-text">
            {v.state === "building"
              ? "初建中（MFT 枚举）…"
              : v.state === "error"
                ? v.error
                : `${v.entries.toLocaleString()} 项`}
          </span>
        </span>
      ))}
    </div>
  );
}

/**
 * 状态条左端索引模式控制组：[dot+标签 chip] + [Switch 常驻开关]。
 * 开关直接可切；打开后自动弹出进度浮层，阶段（启动中/初建中/就绪/失败/离线）2s 刷新；
 * 全部就绪 / 出错时经灵动岛回执播报一次。dot 语义：accent=运行中 building 时脉冲、
 * muted=未开启、danger=离线/错误。
 */
export function IndexModeBar({ status }: { status: IndexStatus | null }) {
  const [open, setOpen] = useState(false);
  const enabled = useSettings((s) => s.nameIndex.enabled);
  const setEnabled = (v: boolean) => useSettings.getState().update({ nameIndex: { enabled: v } });
  const enabledAtRef = useRef<number | null>(null);
  const { phase, vols, totalEntries } = analyzeIndexPhase(
    status,
    enabled,
    enabledAtRef.current,
    Date.now(),
  );
  // 阶段心跳：分钟级轮询里驱动"启动中…"宽限超时回落离线（Date.now() 非响应式，补 1s tick）
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (phase !== "starting") return;
    const t = window.setInterval(() => forceTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [phase]);

  // 成败回执：进入就绪/错误时播报一次（仅在建索引周期内：prev 为 starting/building）
  const prevPhaseRef = useRef<IndexPhase | null>(null);
  useEffect(() => {
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = phase;
    if (prev !== "starting" && prev !== "building") return;
    if (phase === "ready") {
      const s = readySummary(vols, totalEntries);
      if (s) useUi.getState().toast(`索引已就绪：${s}`);
    } else if (phase === "error") {
      const s = errorSummary(vols);
      if (s) useUi.getState().toast(`索引建立失败：${s}`, "error");
    }
    // vols/totalEntries 随轮询变化，但回执只在阶段翻转时发一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const onToggle = (v: boolean) => {
    if (v) enabledAtRef.current = Date.now();
    else enabledAtRef.current = null;
    toggleIndexMode(v, setEnabled, () => setOpen(true)); // 开启即弹进度层
  };

  return (
    <span className="np-gsearch-idxwrap">
      <PopoverNext
        isOpen={open}
        onInteraction={setOpen}
        placement="top-start"
        arrow={false}
        content={
          <div className="np-gsearch-idx-pop">
            <div className="np-gsearch-idx-title">
              {phase === "ready"
                ? "索引已就绪（NTFS 秒搜生效中）"
                : phase === "building" || phase === "starting"
                  ? "索引建立中…"
                  : phase === "error"
                    ? "索引建立失败"
                    : phase === "down"
                      ? "守护进程未运行"
                      : "索引模式（NTFS 秒搜）"}
            </div>
            {phase === "starting" && (
              <div className="np-gsearch-idx-vols">
                <span className="np-gsearch-idx-vol">
                  <span className="np-spin">
                    <AppIcon icon={LoaderCircle} size={DENSITY.iconXs} />
                  </span>
                  <span className="np-gsearch-idx-vol-text">
                    等待守护进程拉起（UAC 授权后自动进行）…
                  </span>
                </span>
              </div>
            )}
            <VolumeRows vols={vols} />
            {phase === "error" && (
              <div className="np-gsearch-idx-hint">
                USN 日志重置类错误守护会自动重建并恢复；若该盘持续失败，重新开关一次索引模式可重试。
              </div>
            )}
            {phase === "down" && (
              <div className="np-gsearch-idx-hint">
                上次启动未成功或守护已退出；重新开关一次索引模式即可再试。
              </div>
            )}
            {phase === "off" && (
              <div className="np-gsearch-idx-hint">
                打开开关建立索引：毫秒级出结果并实时同步文件变更（开启时弹一次 UAC 授权）。
              </div>
            )}
            <div className="np-gsearch-idx-hint">
              未提权 / 非 NTFS 盘自动回退实时遍历。索引存于程序目录 config\index，删除目录即卸载。
            </div>
          </div>
        }
      >
        <button
          className={`np-gsearch-idx np-gsearch-idx-${phase}`}
          title="索引建立进度——点击查看"
        >
          <span className="np-gsearch-idx-dot" />
          <span>{PHASE_LABEL[phase]}</span>
        </button>
      </PopoverNext>
      <Switch
        checked={enabled}
        title="索引模式（NTFS 秒搜）：毫秒级出结果并实时同步文件变更"
        onChange={(e) => onToggle(e.currentTarget.checked)}
      />
    </span>
  );
}

// 剪贴板历史浮窗（§3.7，Ditto 式）：自绘顶栏（标题 + 搜索 + 置顶/最小化/最大化/
// 关闭 + 拖动）+ 类型段选 + 虚拟列表 + 状态行。数据过滤/分页全在
// Rust 端（铁律 3），列表只渲染可见行（铁律 1，TanStack Virtual 动态行高——
// 预览自适应最多 3 行）。搜索默认折叠 = 只显一枚图标（2026-11-12 用户定案，
// 呼出即列表模式）：键入任意字符或点图标展开并聚焦（含 IME 组合首键承接），
// Esc 收起清词，再按关窗。展开后 = 输入模式：可打印字符/空格/数字/Del 进
// 搜索词，↑↓/Enter/Alt+1-9/Ctrl+P 仍作用列表；未展开 = 列表模式：页脚全部
// 快捷键生效（↑↓/WS 选择 · Enter 粘贴 · 1-9 取条 · Space 勾选 · Ctrl+P
// 置顶 · Del 删除 · Esc 关闭），点行内动作钮持有的焦点被 keydown 路由回
// 列表语义。全程不做焦点抢夺——「快捷键与搜索框冲突」自折叠化起根除。
// 自动收由 Rust 管理（失焦停靠，置顶常驻豁免）；本页经窗口 focus 事件感知
// 「被呼出」→ 复位折叠态并刷新。
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Check,
  ClipboardList,
  ScanText,
  Star,
  FolderInput,
  Copy,
  Minus,
  Pin,
  PinOff,
  Search,
  Settings as SettingsIcon,
  Square,
  Trash2,
  X,
} from "lucide-react";

import { api, type ClipHistItem, type Settings } from "../lib/ipc";
import { clipKindMeta, pickDigit, relTime } from "../lib/cliphist";
import { AppIcon } from "../components/AppIcon";
import { initTooltip } from "../lib/tooltip";
import { DENSITY } from "../lib/tokens";

const PAGE = 50;
const ROW_H = DENSITY.rowH;

const KIND_TABS: { v: string; l: string }[] = [
  { v: "", l: "全部" },
  { v: "fav", l: "收藏" },
  { v: "text", l: "文本" },
  { v: "link", l: "链接" },
  { v: "path", l: "路径" },
  { v: "image", l: "图片" },
  { v: "files", l: "文件" },
  { v: "dirs", l: "文件夹" },
];

export function ClipHistWindow() {
  const [items, setItems] = useState<ClipHistItem[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const [sel, setSel] = useState(0);
  const [flash, setFlash] = useState("");
  /** 图片放大预览（T2-1）：原图 dataURL；非空时全窗覆盖层展示 */
  const [viewImg, setViewImg] = useState<string | null>(null);
  /** 多选合并（T1-4）：勾选集合（列表可见序，Enter 合并粘贴） */
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [directPaste, setDirectPaste] = useState(true);
  /** 浮窗置顶常驻（会话级）：失焦不自动收窗，Enter 转为仅复制不关窗（连续取用） */
  const [winPinned, setWinPinned] = useState(false);
  /** 浮窗最大化（顶栏钮/双击顶栏，Rust 侧手动工作区方案；重开后复位） */
  const [isMaxed, setIsMaxed] = useState(false);
  /** 搜索展开态（2026-11-12 用户定案：呼出默认折叠 = 只显图标、不聚焦——
   *  列表模式快捷键即刻全效；键入任意字符或点图标才展开，Esc 收起清词）。
   *  searchFocused 仅驱动页脚提示切换 */
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 装载协程防乱序：仅最后一次发起的请求可落盘（搜索防抖/翻页竞态）
  const loadKey = useRef("");
  const busy = useRef(false);
  const loadedCount = useRef(0);
  const hasMore = useRef(false);
  // 下次刷新要保持选择的条目 id（置顶/删除后选择不跳回首行）
  const keepId = useRef<number | null>(null);
  // 数据武装门闸（2026-11-01 启动速度优化）：本窗由 Rust 在启动预热期常驻
  // 停靠屏幕外，挂载即拉整页 50 条（含缩略图 base64，MB 级 IPC + DB 查询）
  // 纯属浪费——用户真正呼出时 focus 路径本来就会重拉。首次获得焦点才放行
  // 数据通道；focus 事件极端丢失时由 400ms 焦点自卫兜底武装
  const armed = useRef(false);
  // 搜索展开后待补进搜索词的首字符（键入唤起时该字符先于焦点落位被拦下）
  const pendingChar = useRef<string | null>(null);
  // 键盘/事件处理器读取的最新态（避免重绑 window 监听、闭包过期）
  const stateRef = useRef({ items, sel, query, kind, directPaste, winPinned, isMaxed, picked, viewImg, searchOpen });
  stateRef.current = { items, sel, query, kind, directPaste, winPinned, isMaxed, picked, viewImg, searchOpen };

  const fetchPage = useCallback(
    async (offset: number, append: boolean, keep: number | null) => {
      const { query: q, kind: k, items: cur } = stateRef.current;
      const key = `${q}|${k}|${offset}|${append}`;
      loadKey.current = key;
      busy.current = true;
      try {
        const page = await api.cliphistList(q, k, offset, PAGE);
        if (loadKey.current !== key) return;
        const list = append ? [...cur, ...page.items] : page.items;
        setItems(list);
        setTotal(page.total);
        loadedCount.current = offset + page.items.length;
        hasMore.current = loadedCount.current < page.total;
        if (keep != null) {
          const i = list.findIndex((x) => x.id === keep);
          setSel(i >= 0 ? i : 0);
        } else {
          setSel(0);
        }
      } catch {
        // 查询失败静默：保留现有列表（空态兜底）
      } finally {
        busy.current = false;
      }
    },
    [],
  );

  /** 搜索词/类型变更（120ms 防抖）：仅在数据通道武装后（首次聚焦）生效，
   *  停靠态挂载不触发首拉 */
  useEffect(() => {
    if (!armed.current) return;
    const t = window.setTimeout(() => void fetchPage(0, false, null), 120);
    return () => window.clearTimeout(t);
  }, [query, kind, fetchPage]);

  /** 搜索展开后落焦点并补首字符（2026-11-12 折叠搜索定案）：focus 与渲染
   *  同 tick 落位；键入唤起时该字符先于焦点被拦下，从这里补进搜索词 */
  useEffect(() => {
    if (!searchOpen) return;
    inputRef.current?.focus();
    if (pendingChar.current) {
      const ch = pendingChar.current;
      pendingChar.current = null;
      setQuery((q) => q + ch);
    }
  }, [searchOpen]);

  // 挂载一次性接线：偏好（直接粘贴 + 深浅色，轻量窗不走 settings store）、
  // cliphist-updated 事件（聚焦中才刷新）、窗口 focus（= Rust 呼出）刷新+聚焦
  useEffect(() => {
    const offs: (() => void)[] = [initTooltip()];
    const applyTheme = (theme: Settings["theme"]) => {
      const dark =
        theme === "dark" ||
        (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.classList.toggle("bp6-dark", dark);
      // 双锚点同主窗 applyTheme（settings.ts 2026-11-05 加固）：body 镜像挂类
      document.body.classList.toggle("dark", dark);
      document.body.classList.toggle("bp6-dark", dark);
    };
    const onScheme = () => applyTheme("system");
    void api
      .getSettings()
      .then((st) => {
        setDirectPaste(st?.cliphistDirectPaste ?? true);
        const theme = st?.theme ?? "system";
        applyTheme(theme);
        if (theme === "system") {
          window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", onScheme);
        }
      })
      .catch(() => undefined);
    let unlistenEv: (() => void) | undefined;
    void listen("cliphist-updated", () => {
      if (!document.hasFocus()) return;
      // 置顶/删除预登记的保持选择优先，否则维持当前选择条目
      const keep =
        keepId.current ?? stateRef.current.items[stateRef.current.sel]?.id ?? null;
      keepId.current = null;
      void fetchPage(0, false, keep);
    }).then((f) => {
      unlistenEv = f;
    });
    // 配置导入热同步（2026-11-11 审计补）：常驻浮窗是独立 WebView、不随主窗
    // 设置热重载——导入含主题/直接粘贴偏好变更时重读 settings 立即跟随
    let unImported: (() => void) | undefined;
    void listen("config-imported", () => {
      void api
        .getSettings()
        .then((st) => {
          setDirectPaste(st?.cliphistDirectPaste ?? true);
          applyTheme(st?.theme ?? "system");
        })
        .catch(() => undefined);
    }).then((f) => {
      unImported = f;
    });
    let unFocus: (() => void) | undefined;
    // 边缘拖拽调宽高 → 防抖 600ms 持久化（最大化态为工作区尺寸，不落盘）；
    // 建窗时 Rust 读回 cliphistWinW/H（2026-10-31）
    let saveSizeT: number | undefined;
    const onWinResize = () => {
      window.clearTimeout(saveSizeT);
      saveSizeT = window.setTimeout(() => {
        if (stateRef.current.isMaxed) return;
        void api
          .cliphistSaveSize(window.innerWidth, window.innerHeight)
          .catch(() => undefined);
      }, 600);
    };
    window.addEventListener("resize", onWinResize);
    // 数据武装兜底（focus 事件先于监听注册到达的极端时序）：呼出后首次
    // hasFocus 时放行数据通道。不再做任何焦点归还——呼出默认折叠搜索
    // （2026-11-12 用户定案），列表模式快捷键即刻全效，强抢焦点反而制造
    // 「快捷键与搜索框冲突」
    const focusGuard = window.setInterval(() => {
      if (document.hasFocus() && !armed.current) {
        armed.current = true;
        void fetchPage(0, false, null);
      }
    }, 400);
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (!focused) return;
        armed.current = true;
        keepId.current = null;
        // 重开（呼出）时 Rust 已复位默认尺寸，最大化图标同步归零
        setIsMaxed(false);
        // 每次呼出清空搜索词（2026-10-31 用户定案）：有词时清空即触发
        // [query] 防抖效应按空词重拉；无词时直接刷新（stateRef 同 tick
        // 未更新，立即 fetchPage 会带上旧词）
        if (stateRef.current.query) {
          setQuery("");
        } else {
          void fetchPage(0, false, null);
        }
        // 呼出复位折叠态（2026-11-12 用户定案）：默认只显搜索图标、不聚焦
        setSearchOpen(false);
      })
      .then((f) => {
        unFocus = f;
      });
    return () => {
      offs.forEach((f) => f());
      unlistenEv?.();
      unImported?.();
      unFocus?.();
      window.clearInterval(focusGuard);
      window.removeEventListener("resize", onWinResize);
      window.clearTimeout(saveSizeT);
      window
        .matchMedia("(prefers-color-scheme: dark)")
        .removeEventListener("change", onScheme);
    };
  }, [fetchPage]);

  const flashMsg = useCallback((msg: string) => {
    setFlash(msg);
    window.setTimeout(() => setFlash(""), 2500);
  }, []);

  /** 写回：direct = 直接粘贴（Ctrl 修饰、设置关闭或浮窗常驻 = 仅复制）。
   *  常驻态下目标窗口已随交互漂移、自动粘贴语义不再可靠，且关窗违背常驻
   *  初衷——一律仅复制 + 页脚回执，用户手动 Ctrl+V（Rust 侧同判不关窗） */
  const pasteItem = useCallback(
    (item: ClipHistItem, ctrl: boolean) => {
      const { directPaste: dp, winPinned: pinned } = stateRef.current;
      const direct = dp && !ctrl && !pinned;
      api
        .cliphistWriteBack(item.id, direct)
        .then((pasted) => {
          if (pinned) {
            flashMsg("已复制到剪贴板");
          } else if (direct && !pasted) {
            flashMsg("已复制到剪贴板（未能自动粘贴，请手动 Ctrl+V）");
          }
        })
        .catch((e) => flashMsg(`复制失败：${String(e)}`));
    },
    [flashMsg],
  );

  /** 图片条目 OCR 取字（T2-4）：识别文本写回剪贴板（自然入库成新文本条目） */
  const ocrItem = useCallback(
    (item: ClipHistItem) => {
      void api
        .cliphistOcr(item.id)
        .then((t) => flashMsg(`已识别并复制：${t.slice(0, 40)}${t.length > 40 ? "…" : ""}`))
        .catch((e) => flashMsg(`OCR 失败：${String(e)}`));
    },
    [flashMsg],
  );

  /** 打开图片放大预览（T2-1） */
  const openPreview = useCallback((item: ClipHistItem) => {
    if (!item.thumb) return;
    void api
      .cliphistGetImage(item.id)
      .then(setViewImg)
      .catch(() => setViewImg(item.thumb)); // 原图缺失回落缩略
  }, []);

  /** 勾选/取消勾选（T1-4） */
  const togglePick = useCallback((id: number) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  /** 合并粘贴（T1-4）：按列表可见序收集勾选 id → Rust 换行连接回写/粘贴 */
  const mergePaste = useCallback(
    (ctrl: boolean) => {
      const { items: list, picked: set, directPaste: dp, winPinned: pinned } = stateRef.current;
      const ids = list.filter((x) => set.has(x.id)).map((x) => x.id);
      if (!ids.length) return false;
      const direct = dp && !ctrl && !pinned;
      api
        .cliphistMergePaste(ids, direct)
        .then((pasted) => {
          setPicked(new Set());
          if (pinned) {
            flashMsg("已合并复制到剪贴板");
          } else if (direct && !pasted) {
            flashMsg("已合并复制（未能自动粘贴，请手动 Ctrl+V）");
          }
        })
        .catch((e) => flashMsg(`合并失败：${String(e)}`));
      return true;
    },
    [flashMsg],
  );

  /** 浮窗置顶常驻开关：置位 Rust 侧失焦豁免 + 本页回写语义切换 */
  const togglePinWindow = useCallback(() => {
    const next = !stateRef.current.winPinned;
    setWinPinned(next);
    void api.cliphistSetPinned(next).catch(() => undefined);
  }, []);

  /** 顶栏窗口钮：最小化/关闭都为收起（浮窗常驻停靠态、任务栏无入口，系统
   *  最小化会失联）；最大化 = Rust 手动撑满工作区（规避与停靠位互作） */
  const hideWindow = useCallback(() => {
    void api.cliphistHide().catch(() => undefined);
  }, []);

  const toggleMax = useCallback(() => {
    const next = !stateRef.current.isMaxed;
    setIsMaxed(next);
    void api.cliphistSetMaximized(next).catch(() => undefined);
  }, []);

  /** 文件/文件夹条目直接粘贴到主窗活动窗格（T1-2）：Rust 写回 CF_HDROP
   *  并唤主窗走 Ctrl+V 同款粘贴（transfer 进活动窗格目录） */
  const pasteToPane = useCallback(
    (item: ClipHistItem) => {
      void api.cliphistPasteToPane(item.id).catch((e) => flashMsg(`粘贴失败：${String(e)}`));
    },
    [flashMsg],
  );

  const favItem = useCallback((item: ClipHistItem) => {
    void api.cliphistSetFav(item.id, !item.fav).catch(() => undefined);
  }, []);

  const pinItem = useCallback((item: ClipHistItem) => {
    keepId.current = item.id;
    void api.cliphistSetPin(item.id, !item.pinned).catch(() => undefined);
  }, []);

  const delItem = useCallback((item: ClipHistItem) => {
    const { items: list } = stateRef.current;
    const idx = list.findIndex((x) => x.id === item.id);
    // 删除后保持选择落在相邻条目上
    keepId.current = list[idx + 1]?.id ?? list[idx - 1]?.id ?? null;
    void api.cliphistDelete(item.id).catch(() => undefined);
  }, []);

  /** 清空全部未置顶条目：两段式确认（首击布防 3 秒，再击执行——轻量窗无
   *  confirmDialog 基建，且清空影响面大需要防误触） */
  const [clearArmed, setClearArmed] = useState(false);
  const onClear = useCallback(() => {
    if (!clearArmed) {
      setClearArmed(true);
      window.setTimeout(() => setClearArmed(false), 3000);
      return;
    }
    setClearArmed(false);
    keepId.current = null;
    void api.cliphistClear().catch(() => undefined);
  }, [clearArmed]);

  // 行高动态（预览自适应最多 3 行）：estimateSize 给单行基线，实际由
  // measureElement 量测；getItemKey 以条目 id 缓存尺寸，刷新不串行高
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 8,
    getItemKey: (i) => items[i]?.id ?? i,
  });

  const goTo = useCallback(
    (idx: number) => {
      // 视口内不动（auto），出视口才滚动跟随
      virtualizer.scrollToIndex(idx, { align: "auto" });
    },
    [virtualizer],
  );

  // 全局键盘（捕获）：浮窗是独立窗口，keydown 直接在 window 上接
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // IME 组合输入中不接管：Enter=提交候选、Esc=取消组合（截图文字工具
      // 同口径；合成键在中文输入法下 key 呈 "Process"，天然不命中各分支）
      if (e.isComposing || e.keyCode === 229) {
        // IME 组合首键（无焦点可编辑时组合尚未开启）：展开搜索框承接后续
        // 组合文本——focus 在 keydown 同步落位，组合即附着到输入框；不插字符
        //（组合首键的原始字母取不到）、不 preventDefault
        if (!stateRef.current.searchOpen) setSearchOpen(true);
        return;
      }
      const { items: list, sel: i, picked: pk } = stateRef.current;
      const cur = list[i];
      // 按钮焦点劫持修复（2026-11-12）：行内动作钮（收藏/置顶/删除等）点击后
      // 持有焦点，Enter/Space 会二次触发该按钮（无意翻转收藏/置顶）——路由到
      // 列表语义（Enter=合并/粘贴，Space=勾选当前条），与列表模式一致
      if (
        document.activeElement instanceof HTMLButtonElement &&
        (e.key === "Enter" || e.key === " ")
      ) {
        e.preventDefault();
        if (e.key === "Enter") {
          if (pk.size > 0) mergePaste(e.ctrlKey);
          else if (cur) pasteItem(cur, e.ctrlKey);
        } else if (cur) {
          togglePick(cur.id);
        }
        return;
      }
      // W/S 备用导航（截图 WASD 惯例同源）：仅搜索框未聚焦时生效，且必须
      // 判在可打印键兜底之前——否则会被兜底截获进搜索词
      if (
        (e.key === "w" || e.key === "W" || e.key === "s" || e.key === "S") &&
        document.activeElement !== inputRef.current
      ) {
        e.preventDefault();
        const next =
          e.key === "s" || e.key === "S" ? Math.min(i + 1, list.length - 1) : Math.max(i - 1, 0);
        setSel(next);
        goTo(next);
        return;
      }
      // Space 勾选当前条目（T1-4）：仅搜索框未聚焦时（聚焦时是输入字符）。
      // 必须判在可打印键兜底之前——空格 key.length===1，排后会被兜底截获
      // 进搜索词，勾选功能就此失效（2026-11-01 审查发现的顺序回归）
      if ((e.key === " " || e.code === "Space") && document.activeElement !== inputRef.current) {
        e.preventDefault();
        if (cur) togglePick(cur.id);
        return;
      }
      // 数字取条（T2-3）：Alt+1-9 任意时刻；裸 1-9 未聚焦时——同样必须先于
      // 可打印键兜底（数字会被兜底补进搜索词，裸数字取条失效）
      {
        const pick = pickDigit(e, document.activeElement === inputRef.current);
        if (pick !== null) {
          e.preventDefault();
          const item = list[pick];
          if (item) pasteItem(item, e.ctrlKey);
          return;
        }
      }
      // 折叠（或展开未聚焦）时键入任意字符 = 唤起搜索并补该字符
      // （2026-11-12 折叠搜索定案）；展开且聚焦时输入框自然承接不走此支
      if (
        e.key.length === 1 &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey &&
        document.activeElement !== inputRef.current
      ) {
        e.preventDefault();
        pendingChar.current = e.key;
        setSearchOpen(true);
        return;
      }
      switch (e.key) {
        case "ArrowDown":
        case "ArrowUp": {
          e.preventDefault();
          const next =
            e.key === "ArrowDown" ? Math.min(i + 1, list.length - 1) : Math.max(i - 1, 0);
          setSel(next);
          goTo(next);
          break;
        }
        case "Enter":
          e.preventDefault();
          // 勾选集合非空 → 合并粘贴优先（T1-4）
          if (pk.size > 0) {
            mergePaste(e.ctrlKey);
          } else if (cur) {
            pasteItem(cur, e.ctrlKey);
          }
          break;
        case "Escape":
          e.preventDefault();
          if (stateRef.current.viewImg) {
            setViewImg(null);
          } else if (pk.size > 0) {
            setPicked(new Set());
          } else if (stateRef.current.searchOpen) {
            // 收起搜索并清词（回列表模式），再按一次关窗
            setQuery("");
            setSearchOpen(false);
          } else {
            void api.cliphistHide().catch(() => undefined);
          }
          break;
        case "p":
        case "P":
          if (e.ctrlKey && cur) {
            e.preventDefault();
            pinItem(cur);
          }
          break;
        case "Delete":
          // 输入框聚焦时 Del 属于编辑键，不删条目
          if (document.activeElement === inputRef.current) break;
          if (cur) {
            e.preventDefault();
            delItem(cur);
          }
          break;
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pasteItem, pinItem, delItem, goTo, togglePick, mergePaste]);

  /** 缩略图等比清晰适配（onLoad，2026-11-12 用户反馈补）：显示尺寸先压到
   *  源物理像素 1:1（natural/dpr CSS px——低分辨率位图如 228×66 截块在高
   *  DPI 下放大即糊，1:1 显示逐像素锐利），再在 行高 2.4 / 卡片宽 45% 上限
   *  内等比缩小；纵横比恒定、只缩不放。行高变化由虚拟列表 measureElement
   *  的 ResizeObserver 自动重测 */
  const fitThumb = (e: { currentTarget: HTMLImageElement }) => {
    const el = e.currentTarget;
    const dpr = window.devicePixelRatio || 1;
    const w1 = el.naturalWidth / dpr;
    const h1 = el.naturalHeight / dpr;
    if (!w1 || !h1) return;
    const card = el.closest(".np-clip-card");
    const capW = ((card?.clientWidth ?? 400) * 2) / 4.5;
    const capH = DENSITY.rowH * 2.4;
    const scale = Math.min(1, capW / w1, capH / h1);
    el.style.width = `${(w1 * scale).toFixed(1)}px`;
    el.style.height = `${(h1 * scale).toFixed(1)}px`;
  };

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || busy.current || !hasMore.current) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - ROW_H * 4) {
      void fetchPage(loadedCount.current, true, null);
    }
  }, [fetchPage]);

  return (
    <div className="np-clip">
      {/* 自绘顶栏（2026-11-06 方案 C + 搜索上移）：logo 章 + 标题 +
          搜索框（胶囊填充式，顶栏主入口）+ 窗口五钮；条数只在底栏展示
          （2026-11-11 用户反馈：顶栏计数副行与底栏重复，退役）；拖动区 =
          data-tauri-drag-region（双击 = 最大化/还原），窗口钮复用 np-winbtn
          统一配方 */}
      <header
        className="np-cliptb"
        data-tauri-drag-region
        data-tip-down=""
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest("button, input")) return;
          toggleMax();
        }}
      >
        <span className="np-cliptb-logo" data-tauri-drag-region>
          <AppIcon icon={ClipboardList} size={DENSITY.iconSm} />
        </span>
        <span className="np-cliptb-id" data-tauri-drag-region>
          <span className="np-cliptb-title">剪贴板</span>
        </span>
        {searchOpen ? (
          <div className="np-clip-searchbar">
            <AppIcon icon={Search} size={DENSITY.iconSm} />
            <input
              ref={inputRef}
              className="np-clip-search"
              value={query}
              spellCheck={false}
              placeholder="搜索文本与文件路径…"
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
            />
          </div>
        ) : (
          /* 折叠态 = 仅一枚搜索图标（np-winbtn 顶栏图标钮基底）；点开或
              直接键入任意字符展开完整搜索框（2026-11-12 用户定案） */
          <button
            className="np-winbtn"
            data-tip="搜索（键入任意字符亦可唤起）"
            aria-label="搜索剪贴板历史"
            onClick={() => setSearchOpen(true)}
          >
            <AppIcon icon={Search} size={DENSITY.iconSm} />
          </button>
        )}
        <button
          className="np-winbtn"
          data-tip="打开 X-Dir 设置（浮窗收起）"
          onClick={() => {
            void api.cliphistOpenSettings().catch(() => undefined);
          }}
        >
          <AppIcon icon={SettingsIcon} size={DENSITY.iconSm} />
        </button>
        <button
          className={`np-winbtn ${winPinned ? "is-on" : ""}`}
          data-tip={
            winPinned
              ? "浮窗常驻：开（点击恢复失焦自动关闭）"
              : "浮窗常驻：关（点击常驻屏幕，失焦不自动关闭，Enter 转为仅复制）"
          }
          aria-label="浮窗常驻开关"
          onClick={togglePinWindow}
        >
          <AppIcon icon={winPinned ? PinOff : Pin} size={DENSITY.iconSm} />
        </button>
        <button
          className="np-winbtn"
          data-tip="最小化（收起浮窗，热键再唤）"
          onClick={hideWindow}
        >
          <AppIcon icon={Minus} size={DENSITY.iconSm} />
        </button>
        <button
          className="np-winbtn"
          data-tip={isMaxed ? "还原" : "最大化（撑满当前屏幕）"}
          onClick={toggleMax}
        >
          <AppIcon icon={isMaxed ? Copy : Square} size={DENSITY.iconSm} />
        </button>
        <button className="np-winbtn np-winbtn-close" data-tip="关闭（收起浮窗）" onClick={hideWindow}>
          <AppIcon icon={X} size={DENSITY.iconSm} />
        </button>
      </header>
      <div className="np-clip-head">
        {/* 过滤档（方案 C：实心选中 pill；搜索框已上移顶栏） */}
        <div className="np-clip-seg">
          {KIND_TABS.map((t) => (
            <button key={t.v} className={kind === t.v ? "is-on" : ""} onClick={() => setKind(t.v)}>
              {t.l}
            </button>
          ))}
        </div>
      </div>
      <div ref={scrollRef} className="np-clip-list" onScroll={onScroll}>
        {items.length === 0 ? (
          <div className="np-clip-empty">
            {query ? "没有匹配的条目" : "暂无剪贴板历史——复制点什么试试"}
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const it = items[vi.index];
              const kMeta = clipKindMeta(it.kind);
              // 类型色族：图片=蓝 文件夹/文件=橙 其余=灰（--np-icon-* 同源语义）
              const kCls = it.kind === "image" ? "image" : it.kind === "files" || it.kind === "dirs" ? "files" : "text";
              return (
                <div
                  key={it.id}
                  ref={virtualizer.measureElement}
                  data-index={vi.index}
                  className={`np-clip-row ${
                    vi.index === sel ? "is-sel" : ""
                  } ${picked.has(it.id) ? "is-pick" : ""}`}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  {/* 可见卡片本体：外壳（np-clip-row）只承载虚拟列表定位/量测
                      与底部 8px 间隔 padding——间隔进量测盒且不污染卡片圆角
                      （border 间隔会让 padding-box 圆角随相邻边 border 宽
                      不等变成椭圆，2026-11-07 用户报四角不一致根因）。
                      点击/勾选挂卡片本体：点间隔空白不误触粘贴 */}
                  <div
                    className="np-clip-card"
                    onClick={(e) => {
                      if (e.ctrlKey) {
                        e.stopPropagation();
                        togglePick(it.id);
                      } else {
                        pasteItem(it, false);
                      }
                    }}
                  >
                  {picked.has(it.id) ? (
                    <span className="np-clip-idx np-clip-idxpick" data-tip="已勾选">
                      <AppIcon icon={Check} size={DENSITY.iconXs} />
                    </span>
                  ) : (
                    <span className="np-clip-idx">{vi.index + 1}</span>
                  )}
                  {it.thumb ? (
                    <img
                      className="np-clip-thumb"
                      src={it.thumb}
                      alt=""
                      onLoad={fitThumb}
                      data-tip="点击放大预览"
                      onClick={(e) => {
                        e.stopPropagation();
                        openPreview(it);
                      }}
                    />
                  ) : null}
                  <div className="np-clip-body">
                    <div className="np-clip-crow">
                      <span className="np-clip-preview">{it.preview}</span>
                      {it.pinned && (
                        <span className="np-clip-pinmark" data-tip="已置顶">
                          <AppIcon icon={Pin} size={DENSITY.iconXs} />
                        </span>
                      )}
                      {it.fav && (
                        <span className="np-clip-favmark" data-tip="已收藏">
                          <AppIcon icon={Star} size={DENSITY.iconXs} />
                        </span>
                      )}
                      <span className={`np-clip-chip k-${kCls}`}>{kMeta.label}</span>
                    </div>
                    {/* meta 行：相对时间 + 来源应用（方案 C 新信息位）+ 悬停动作组 */}
                    <div className="np-clip-meta">
                      <span>{relTime(it.createdAt)}</span>
                      {it.source && (
                        <>
                          <span className="np-clip-dot" />
                          <span className="np-clip-src">{it.source}</span>
                        </>
                      )}
                      <span className="np-clip-actions">
                        <button
                          data-tip={it.fav ? "取消收藏" : "收藏（永久保留，排最前）"}
                          onClick={(e) => {
                            e.stopPropagation();
                            favItem(it);
                          }}
                        >
                          <AppIcon icon={Star} size={DENSITY.iconXs} />
                        </button>
                        <button
                          data-tip={it.pinned ? "取消置顶" : "置顶（豁免清理）"}
                          onClick={(e) => {
                            e.stopPropagation();
                            pinItem(it);
                          }}
                        >
                          <AppIcon icon={it.pinned ? PinOff : Pin} size={DENSITY.iconXs} />
                        </button>
                        {it.kind === "image" && (
                          <button
                            data-tip="OCR 取字（识别文字进剪贴板）"
                            onClick={(e) => {
                              e.stopPropagation();
                              ocrItem(it);
                            }}
                          >
                            <AppIcon icon={ScanText} size={DENSITY.iconXs} />
                          </button>
                        )}
                        {(it.kind === "files" || it.kind === "dirs") && (
                          <button
                            data-tip="粘贴到当前窗格（主窗活动目录）"
                            onClick={(e) => {
                              e.stopPropagation();
                              pasteToPane(it);
                            }}
                          >
                            <AppIcon icon={FolderInput} size={DENSITY.iconXs} />
                          </button>
                        )}
                        <button
                          className="np-clip-del"
                          data-tip="删除"
                          onClick={(e) => {
                            e.stopPropagation();
                            delItem(it);
                          }}
                        >
                          <AppIcon icon={Trash2} size={DENSITY.iconXs} />
                        </button>
                      </span>
                    </div>
                  </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {viewImg && (
        <div className="np-clip-viewer" onClick={() => setViewImg(null)}>
          <img src={viewImg} alt="" />
          <span className="np-clip-viewer-tip">点击任意处或按 Esc 关闭</span>
        </div>
      )}
      {/* 页脚悬浮胶囊（方案 C）：计数 + 清空 + 完整快捷键清单（2026-10-31
          定案保留），flash 回执占位同高 */}
      <div className="np-clip-foot">
        {flash ? (
          <span className="np-clip-flash">{flash}</span>
        ) : (
          <div className="np-clip-footbar">
            <span className="np-clip-count">{total} 条</span>
            <button
              className="np-clip-clear"
              data-tip="清空全部未置顶条目（两击确认）"
              onClick={onClear}
            >
              <AppIcon icon={Trash2} size={DENSITY.iconXs} />
              {clearArmed ? "确认清空？" : "清空"}
            </button>
            <span className="np-clip-keys">
              {picked.size > 0
                ? `已勾选 ${picked.size} 条 · Enter 合并粘贴 · Space 续选 · Esc 取消`
                : searchFocused
                  ? "输入即搜索 · ↑↓ 选择 · Enter 粘贴 · Alt+1-9 取条 · Esc 收起搜索"
                  : winPinned
                    ? "↑↓/WS 选择 · Enter 复制（常驻中） · 1-9 取条 · Space 勾选 · Ctrl+P 置顶 · Del 删除 · Esc 关闭"
                    : "↑↓/WS 选择 · Enter 粘贴 · 1-9 取条 · Space 勾选 · Ctrl+P 置顶 · Del 删除 · Esc 关闭"}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

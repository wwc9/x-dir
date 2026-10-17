# X-Dir

Windows 优先的轻量级多窗格文件管理器（单窗口 + N 窗格）。需求与技术路线见 `REQUIREMENTS.md`。

技术栈：Tauri 2 + React + TypeScript + Tailwind CSS 4 + Zustand + TanStack Virtual + react-resizable-panels。

## 开发

```powershell
npm install        # 首次
npm run tauri dev  # 桌面应用开发调试
npm run build      # 前端类型检查 + 构建（不含 Rust）
```

Rust 工具链要求 rustup + stable-msvc（VS 2022 Build Tools"使用 C++ 的桌面开发"）。

## M0 内存原型（当前状态）

- 前端：固定 2×5 十窗格，每格 TanStack Virtual 虚拟滚动，固定行高 28px，按 500 条/页向 Rust 拉取
- Rust：`fake_list_dir(path, offset, limit)` 现生成 10,000 条结构化假数据（含 String 路径字段），走完整 IPC 链路
- 目的：按 REQUIREMENTS.md §4.1/§4.2 验证内存预算 → GO / 切 WPF 预案

### 内存实测步骤（验收口径：任务管理器"详细信息"页"专用工作集"列）

1. `npm run tauri dev`（dev 模式偏高，**正式测量用 release**：`npm run tauri build` 后运行 `src-tauri/target/release/X-Dir.exe`，或 `npm run tauri build -- --no-bundle` 只出 exe）
2. 启动后不做任何操作，静置 60 秒
3. 任务管理器 → 详细信息 → 找到 `X-Dir.exe` 进程组（WebView2 会带多个子进程，**合计**其专用工作集；也可用 Process Explorer 看进程树总和）
4. 重复 3 次取中位数
5. 对照 §4.2 预算分解：WebView2 基础 90~140MB + 前端堆 ≤60MB + Rust ≤60MB，总计 <350MB → GO

### 压测数据脚本（M2 用）

`tools/gen-test-tree.ps1`：生成 10 × 1.2 万真实小文件，供接入真实文件系统后复测内存与滚动帧率。

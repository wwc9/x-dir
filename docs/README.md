# X-Dir 文档索引

X-Dir 是一款 Windows 桌面文件管理器（Tauri 2 + React 19 + Rust）。本文档与仓库根部的文档分工如下；
新增文档须同时登记进本索引与根目录 `AGENTS.md` §0。

## 使用者

- [README.md](../README.md) / [README.en.md](../README.en.md)：功能总览、界面截图、安装方式
- [docs/manual/](manual/README.md)：**完整使用手册**——从安装启动到功能库逐工具图文讲解（14 篇基础 + 44 篇工具，全部实机截图）

## 贡献者与 AI 编码代理

| 文档 | 内容 |
|---|---|
| [REQUIREMENTS.md](../REQUIREMENTS.md) | 需求与技术路线：产品决策唯一来源（功能范围、性能验收、架构、里程碑） |
| [AGENTS.md](../AGENTS.md) | 编码规范主文档：工具链 / 性能铁律 / IPC / UI 速览 / 测试 / 提交同步 / 合规速览 / 发布速览 |
| [docs/agents/ui-standards.md](agents/ui-standards.md) | UI 标准规范详版：设计 token、组件选用优先级、密度、图标四档、二级页面规范、参数面板对齐细则与验收清单 |
| [docs/agents/features.md](agents/features.md) | 功能定案清单：各功能域（基础组件/浏览/搜索/预览/PDF/办公/图片/工具箱/截图/剪贴板等）的组件选型、模块归属、实现定案与注意事项 |
| [docs/agents/opensource.md](agents/opensource.md) | 开源合规详版：协议红线与打回台账、依赖白名单选型台账、THIRD-PARTY-NOTICES 生成 |
| [docs/release.md](release.md) | Gitee/GitHub 双端 Release 发布流程：版本/构建/发行说明/发布步骤/坑速查 |
| [docs/screenshots/](screenshots/) | README 用界面截图 |

## 阅读顺序建议

1. 新贡献者：README → REQUIREMENTS.md §1–2（定位与形态）→ AGENTS.md 全文
2. 改 UI：AGENTS.md §4 → ui-standards.md 通读 → features.md 对应功能域
3. 改后端命令：AGENTS.md §3 → features.md 对应功能域 → REQUIREMENTS.md §6
4. 发版本：docs/release.md 全文

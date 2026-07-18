# FolioLoom V1.0 发布设计

日期：2026-07-18
状态：待实施

## 1. 目标

把当前 `translator-v5` 作为 FolioLoom 的首个开源版本发布，而不扩张为通用翻译产品，也不在本轮开发 GUI、安装器、插件市场或 npm 公共包。

正式标识固定为：

- 项目名：`FolioLoom`
- 版本：`1.0.0`
- Git Tag：`v1.0.0`
- 一句话定位：`A continuity-aware translation engine for long-form fiction.`
- 中文定位：面向长篇小说、具备叙事连续性记忆的 AI 翻译引擎
- 许可证：MIT
- 许可证持有人：`daanaagua`

V1.0 表示现有 V5 工程内核形成了可辨识、可测试、可审计的首次公开版本，不表示已经具备消费级 GUI、广泛模型适配或大规模社区验证。

## 2. 范围

### 2.1 本轮包含

1. 将 `translator-v5/package.json` 的项目名改为 `folioloom`，版本改为 `1.0.0`，增加项目描述和明确的 FolioLoom CLI npm script。
2. 保留 `translator-v5/` 目录名，避免为发布制造大规模路径迁移。
3. 在仓库根目录增加标准 MIT `LICENSE`。
4. 增加 GitHub Actions，只验证正式 V1.0 内核：
   - `npm ci`
   - `npm test`
   - `npm run typecheck`
5. 重写 README 的开头和快速开始，使 FolioLoom/V1.0 成为唯一正式入口；Python V1–V4 明确标记为 legacy/研究历史。
6. 将公开仓库 `daanaagua/novel-translate-public` 重命名为 `daanaagua/FolioLoom`。
7. 创建 `v1.0.0` Tag 和 GitHub Release，发布源代码，不附带模型输出、小说原文、数据库或安装包。

### 2.2 本轮不包含

- GUI、桌面程序或浏览器工作台整合；
- npm registry 发布；
- 将 TypeScript V5 移到仓库根目录；
- 删除或重构 Python V1–V4；
- 新增模型 Provider 或文件格式；
- 为发布重新跑一整本小说；
- 声称 FolioLoom 的文学质量优于 AiNiee、GalTransl 等项目。

## 3. 仓库与版权边界

私有工作仓库曾跟踪过受版权保护的小说 DOCX，因此不得把私有仓库历史直接公开，也不得把私有 `main` 强制推送到公开仓库。

公开发布继续使用已经建立的无历史干净快照：

- 私有仓库保留完整研发历史；
- 公开仓库只接收当前可发布源码；
- 公开树不得包含 `.docx`、`.epub`、小说 `.txt`、SQLite 数据库、`projects/`、模型输出、API Key 或本机认证配置；
- 发布前同时检查当前树和 Git 历史，不能只依赖 `.gitignore`；
- 本地尚未提交的用户文件不得被顺带加入发布。

公开仓库重命名后，以 `https://github.com/daanaagua/FolioLoom` 作为正式地址。旧地址是否由 GitHub 自动跳转不作为程序依赖。

## 4. 包与命令标识

`translator-v5/package.json` 采用：

```json
{
  "name": "folioloom",
  "version": "1.0.0",
  "private": true,
  "description": "A continuity-aware translation engine for long-form fiction."
}
```

`private: true` 保留，防止误发布到 npm。V1.0 的 CLI 是仓库内 npm script，不承诺全局可执行文件：

```powershell
npm run folioloom -- book <action> ...
```

现有 `pilot` 和 `book` scripts 暂时保留为兼容入口。不得只做显示层改名而破坏已有命令和测试。

## 5. README 结构

根 README 首屏只回答五件事：

1. FolioLoom 是什么；
2. V1.0 适合什么，不适合什么；
3. 如何安装 Node 依赖；
4. 如何运行预检、翻译、状态、恢复、审计和导出；
5. 项目数据和 API Key 如何保持在本机。

随后才保留 legacy Python/V4 说明。README 必须明确：

- 正式内核位于 `translator-v5/`；
- 当前以 CLI 为主；
- V4 本地裁决页和旧 Streamlit 页面不是 V1.0 主 GUI；
- V1.0 已通过离线回归和小规模真实模型门禁，但尚未以最新版架构完成公开全书基准；
- 用户必须只翻译自己有权处理的文本。

## 6. CI

创建 `.github/workflows/ci.yml`，在 `push` 和 `pull_request` 到 `main` 时运行。工作目录固定为 `translator-v5`，运行环境使用 Windows 和 Node 24，以贴近当前开发及 `node:sqlite` 运行条件。

CI 只验证 FolioLoom V1.0 的 TypeScript 内核。Python legacy 测试不进入首个公开门禁，原因是其中仍有依赖外部密钥的历史实验脚本；README 应说明该边界，不能用“全仓测试全部通过”描述 CI。

CI 需要使用 `npm ci`，不得读取本机 OpenCode 配置、真实 API Key 或调用收费模型。

## 7. Release 内容

GitHub Release 标题：`FolioLoom v1.0.0`

Release notes 包含：

- 无损源文本账本与独立审计；
- 可恢复、版本隔离的全书运行；
- 有证据的实体别名和再验证；
- 波次级术语锚点；
- 结构化文风状态；
- 有界 Agent 证据检索和局部修复；
- TXT/EPUB 等输入仍需要仓库现有适配流程；
- 当前为 CLI、自用型开源版本；
- 已知限制：没有统一 GUI、没有公开全书基准、Provider 配置仍偏开发者使用。

Release 不附加翻译样本原文、数据库、凭据或从受版权作品生成的完整译文。

## 8. 验收条件

发布前必须同时满足：

1. `translator-v5` 的 Node 测试全部通过；
2. `npm run typecheck` 通过；
3. `package-lock.json` 与 `package.json` 中的名称和版本一致；
4. CI YAML 可被 GitHub Actions 识别且首次运行成功；
5. 公开仓库可见性为 `PUBLIC`，默认分支为 `main`；
6. 公开 Git 树及其公开历史不包含小说原文、数据库、项目工件或密钥；
7. `v1.0.0` 指向通过验证的公开提交；
8. GitHub Release 已公开且链接可访问；
9. 私有工作仓库中原有的未提交用户修改保持不变；
10. README 不把未完成的 GUI、全书基准或文学质量比较写成已完成功能。

## 9. 回退

- CI 失败：不创建 Tag 和 Release，修复后重新验证。
- 公开树发现敏感或受版权文件：立即停止发布；若已经推送，则删除公开仓库或重写尚未传播的公开历史后重新创建干净快照。
- 仓库重命名失败：保留现有公开仓库名称，不影响本地代码和测试；确认权限后再重试。
- Release 内容有误：保留 `v1.0.0` Tag 不动，只修订 Release notes；若 Tag 指向错误提交，则删除尚未对外宣布的 Tag，重新验证后创建。

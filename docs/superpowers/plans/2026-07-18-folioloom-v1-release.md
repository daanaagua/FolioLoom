# FolioLoom V1.0 发布实施计划

> **面向 AI 代理的工作者：** 使用 `executing-plans` 在当前仓库顺序实施。本计划没有值得隔离的并行开发任务，不使用子代理。步骤使用复选框跟踪。

**目标：** 将当前 `translator-v5` 以 FolioLoom `v1.0.0` 的身份完成命名、MIT 授权、离线 CI、公开仓库重命名和首个 GitHub Release。

**架构：** 私有研发仓库继续保留完整历史和 legacy 代码；公开仓库继续采用不含小说原文的干净历史。V1.0 不移动 `translator-v5/`，只在包标识、README 和发布元数据上将其确立为 FolioLoom 正式内核。

**技术栈：** TypeScript、Node.js 24、Node test runner、GitHub Actions、GitHub CLI、MIT License。

---

## 文件结构

- 修改：`translator-v5/package.json`——FolioLoom 名称、版本、描述和 npm script。
- 修改：`translator-v5/package-lock.json`——与 package 元数据保持一致。
- 创建：`LICENSE`——MIT 许可证。
- 修改：`README.md`——FolioLoom V1.0 首屏、快速开始、能力边界和 legacy 导航。
- 创建：`.github/workflows/ci.yml`——V1.0 TypeScript 内核的无密钥离线门禁。
- 创建：`docs/releases/v1.0.0.md`——GitHub Release 的可版本化说明。
- 同步：`D:\llm\novel-translate-public-release`——已净化的公开工作副本。

## Task 1：锁定包身份和兼容命令

**文件：**

- 修改：`translator-v5/package.json`
- 修改：`translator-v5/package-lock.json`

- [x] **步骤 1：记录当前兼容入口**

运行：

```powershell
Set-Location D:\llm\小说翻译\translator-v5
npm.cmd pkg get name version private scripts
```

预期：名称仍为 `deepnovel-translator-v5-pilot`，并存在 `test`、`typecheck`、`pilot`、`book` scripts。

- [x] **步骤 2：修改 package 元数据**

将关键字段改为：

```json
{
  "name": "folioloom",
  "version": "1.0.0",
  "private": true,
  "description": "A continuity-aware translation engine for long-form fiction.",
  "scripts": {
    "test": "node --test --import tsx test/**/*.test.ts",
    "typecheck": "tsc --noEmit",
    "folioloom": "tsx src/cli.ts",
    "pilot": "tsx src/cli.ts",
    "book": "tsx src/cli.ts book"
  }
}
```

保留旧 scripts，避免破坏现有测试和本地命令。

- [x] **步骤 3：只更新 lockfile 元数据**

运行：

```powershell
npm.cmd install --package-lock-only --ignore-scripts
```

预期：`package-lock.json` 顶层及根 package 均显示 `folioloom@1.0.0`，依赖版本不发生无关升级。

- [x] **步骤 4：验证新旧入口**

运行：

```powershell
npm.cmd pkg get name version private description scripts
npm.cmd run folioloom -- book doctor `
  --manifest ..\projects\dragon_waiting_flash\source_manifest.json `
  --max-blocks 1
npm.cmd test
npm.cmd run typecheck
```

预期：`doctor` 输出一块源文本的稳定 JSON，证明新 npm script 把参数传给同一 `src/cli.ts`。该命令不得加载模型配置或调用收费模型。

- [x] **步骤 5：提交包身份**

```powershell
git add translator-v5/package.json translator-v5/package-lock.json
git commit -m "chore: name FolioLoom v1 package"
```

## Task 2：增加许可证和 V1.0 README

**文件：**

- 创建：`LICENSE`
- 修改：`README.md`

- [x] **步骤 1：创建标准 MIT 许可证**

使用未经改写的 MIT 正文，版权行固定为：

```text
Copyright (c) 2026 daanaagua
```

- [x] **步骤 2：重写 README 首屏**

README 开头按以下顺序组织：

```markdown
# FolioLoom

A continuity-aware translation engine for long-form fiction.

FolioLoom 是……

## V1.0 能做什么
## 当前限制
## 安装
## 快速开始
## V1.0 命令
## 数据、密钥与版权
## Legacy V1–V4
```

快速开始使用仓库内真实存在的命令，不发明全局 `folioloom.exe`。示例采用：

```powershell
Set-Location translator-v5
npm.cmd ci
npm.cmd run folioloom -- book doctor --manifest ..\projects\my_book\source_manifest.json
npm.cmd run folioloom -- book run `
  --manifest ..\projects\my_book\source_manifest.json `
  --store ..\projects\my_book\artifacts\folioloom\book.db `
  --config ..\config\config.yaml `
  --max-windows 1
```

其余 `doctor/run/status/recover/audit/export` 参数从 `translator-v5/src/cli.ts` 的解析器逐项核对。若完整命令过长，链接到一个“命令参考”小节，不能使用无法直接运行的省略号冒充快速开始。

- [x] **步骤 3：明确诚实边界**

README 必须明确写出：

- V1.0 正式内核在 `translator-v5/`；
- 当前主要通过 CLI 使用；
- V4 本地裁决页不是 V1.0 统一 GUI；
- 离线测试和真实小窗口门禁已经完成，但最新版尚无公开全书基准；
- API Key 只从本地配置或环境变量读取；
- 用户只能处理自己有权翻译的文本。

- [x] **步骤 4：验证 README 中的路径和命令名**

运行：

```powershell
rg -n "DeepNovel-Translator|deepnovel-translator-v5-pilot|translator-v5|folioloom|book (preflight|doctor|run|status|recover|audit|export)" README.md translator-v5/package.json translator-v5/src/cli.ts
Test-Path LICENSE
```

预期：旧名称只允许出现在明确的历史说明中；所有正式入口称为 FolioLoom。

- [x] **步骤 5：提交文档与许可证**

```powershell
git add LICENSE README.md
git commit -m "docs: introduce FolioLoom v1"
```

## Task 3：建立无密钥 GitHub Actions 门禁

**文件：**

- 创建：`.github/workflows/ci.yml`

- [x] **步骤 1：编写 CI workflow**

使用以下确定结构：

```yaml
name: FolioLoom CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

permissions:
  contents: read

jobs:
  core:
    runs-on: windows-latest
    defaults:
      run:
        working-directory: translator-v5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "24"
          cache: npm
          cache-dependency-path: translator-v5/package-lock.json
      - run: npm ci
      - run: npm test
      - run: npm run typecheck
```

workflow 不配置 secrets，不运行真实模型，也不收集 Python legacy 测试。

- [x] **步骤 2：本地解析 YAML 并核对危险字段**

运行：

```powershell
@'
from pathlib import Path
import yaml
p = Path('.github/workflows/ci.yml')
data = yaml.safe_load(p.read_text(encoding='utf-8'))
assert data['permissions'] == {'contents': 'read'}
text = p.read_text(encoding='utf-8').lower()
assert 'secret' not in text
assert 'npm test' in text
assert 'npm run typecheck' in text
print('ci-yaml-ok')
'@ | python -
```

预期：输出 `ci-yaml-ok`。

- [x] **步骤 3：重复执行 CI 对应命令**

```powershell
Set-Location translator-v5
npm.cmd ci
npm.cmd test
npm.cmd run typecheck
```

预期：204 项或更多 Node 测试通过，类型检查通过。

- [x] **步骤 4：提交 CI**

```powershell
git add .github/workflows/ci.yml
git commit -m "ci: verify FolioLoom core"
```

## Task 4：编写版本化 Release notes

**文件：**

- 创建：`docs/releases/v1.0.0.md`

- [x] **步骤 1：写入 Release notes**

固定包含以下章节：

```markdown
# FolioLoom v1.0.0

## Highlights
## Verification
## Current limitations
## Safety and data ownership
```

Highlights 只描述已经存在的无损账本、审计/恢复、证据型实体链接、波次术语锚点、结构化风格和局部修复。Verification 写明离线测试数量及真实一/三窗口门禁；limitations 写明 CLI、无公开全书基准、Provider 配置偏开发者。

- [x] **步骤 2：扫描夸大和占位文本**

```powershell
rg -n "TODO|TBD|待定|best|领先|全面优于|production-ready|GUI 已完成" docs/releases/v1.0.0.md
```

预期：无命中；“CLI”“没有统一 GUI”“尚无公开全书基准”均有明确说明。

- [x] **步骤 3：提交 Release notes**

```powershell
git add docs/releases/v1.0.0.md
git commit -m "docs: prepare FolioLoom v1 release notes"
```

## Task 5：完整本地发布前验证

**文件：**

- 不修改源码；失败时回到对应任务修复并单独提交。

- [x] **步骤 1：运行 V1.0 内核回归**

```powershell
Set-Location D:\llm\小说翻译\translator-v5
npm.cmd test
npm.cmd run typecheck
```

预期：全部通过。

- [x] **步骤 2：检查 diff 和用户文件**

```powershell
Set-Location D:\llm\小说翻译
git diff --check
git status --short
git log --oneline --decorate -8
```

预期：原有 `docs/superpowers/reports/2026-07-18-little-big-lossless-migration.md` 用户修改仍未被提交；发布改动均已进入独立提交。

- [x] **步骤 3：扫描当前公开候选树**

```powershell
git ls-tree -r --name-only HEAD | Where-Object {
  $_ -match '(?i)(\.docx$|\.epub$|\.sqlite3?$|\.db$|^projects/)'
}
git grep -n -I -E 'gh[pousr]_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16}' HEAD
```

预期：文件扫描只会暴露私有仓库仍跟踪的已知小说 DOCX，因此再次确认不得公开推送私有历史；密钥扫描无真实凭据。

## Task 6：同步干净公开工作副本

**文件：**

- 同步到：`D:\llm\novel-translate-public-release`

- [ ] **步骤 1：验证公开副本身份与干净状态**

```powershell
Set-Location D:\llm\novel-translate-public-release
git status --short
git remote -v
git log --oneline -2
```

预期：工作树干净，当前历史只有已净化的公开提交，remote 指向 `daanaagua/novel-translate-public`。

- [ ] **步骤 2：生成仅含已提交变更的补丁**

在私有仓库中运行：

```powershell
Set-Location D:\llm\小说翻译
git diff --binary --output="$env:TEMP\folioloom-v1.patch" `
  9e06c1a..HEAD -- . ":(exclude)Book of the New Sun.docx"
```

补丁基线 `9e06c1a` 对应首次公开快照的源码状态；它不会包含用户未提交修改或被排除的 DOCX。

- [ ] **步骤 3：在公开副本中应用补丁**

```powershell
Set-Location D:\llm\novel-translate-public-release
git apply --check $env:TEMP\folioloom-v1.patch
git apply $env:TEMP\folioloom-v1.patch
git status --short
```

预期：只出现本计划涉及的源码、README、LICENSE、CI、规格/计划和 Release notes；不得出现小说或项目工件。

- [ ] **步骤 4：在公开副本重复安全扫描与测试**

```powershell
git ls-files | Where-Object {
  $_ -match '(?i)(\.docx$|\.epub$|\.sqlite3?$|\.db$|^projects/)'
}
Set-Location translator-v5
npm.cmd ci
npm.cmd test
npm.cmd run typecheck
```

预期：敏感工件列表为空，测试和类型检查通过。

- [ ] **步骤 5：提交公开发布候选**

```powershell
Set-Location D:\llm\novel-translate-public-release
git add LICENSE README.md .github translator-v5 docs
git commit -m "release: FolioLoom v1.0.0"
```

提交前再次运行 `git status --short`，确保没有遗漏本计划产生的文件。

## Task 7：重命名公开仓库并触发 CI

**文件：**

- GitHub 仓库：`daanaagua/novel-translate-public`

- [ ] **步骤 1：确认目标名未被占用**

```powershell
gh repo view daanaagua/FolioLoom --json nameWithOwner 2>&1
```

预期：仓库不存在；若已经存在，停止，不覆盖或删除任何远端仓库。

- [ ] **步骤 2：重命名公开仓库**

```powershell
gh repo rename FolioLoom --repo daanaagua/novel-translate-public --yes
```

预期：返回成功，仓库仍为 `PUBLIC`。

- [ ] **步骤 3：更新并验证公开副本 remote**

```powershell
Set-Location D:\llm\novel-translate-public-release
git remote set-url origin https://github.com/daanaagua/FolioLoom.git
gh repo view daanaagua/FolioLoom --json nameWithOwner,url,visibility,defaultBranchRef
```

预期：`visibility` 为 `PUBLIC`，默认分支为 `main`。

- [ ] **步骤 4：推送发布候选并等待 CI**

```powershell
git push origin main
$runId = gh run list --repo daanaagua/FolioLoom `
  --workflow "FolioLoom CI" --limit 1 `
  --json databaseId --jq '.[0].databaseId'
gh run watch $runId --repo daanaagua/FolioLoom --exit-status
```

预期：首次 Actions run 成功。失败时不得创建 Tag 或 Release。

## Task 8：创建 v1.0.0 Tag 和 GitHub Release

**文件：**

- 使用：`docs/releases/v1.0.0.md`

- [ ] **步骤 1：确认 Tag 尚不存在且工作树干净**

```powershell
Set-Location D:\llm\novel-translate-public-release
git status --short
git tag --list v1.0.0
git ls-remote --tags origin refs/tags/v1.0.0
```

预期：工作树干净，本地和远端均无 `v1.0.0`。

- [ ] **步骤 2：创建带注释 Tag 并推送**

```powershell
git tag -a v1.0.0 -m "FolioLoom v1.0.0"
git push origin v1.0.0
```

- [ ] **步骤 3：创建公开 Release**

```powershell
gh release create v1.0.0 `
  --repo daanaagua/FolioLoom `
  --title "FolioLoom v1.0.0" `
  --notes-file docs/releases/v1.0.0.md `
  --verify-tag
```

不附加二进制、小说、数据库或翻译产物。

- [ ] **步骤 4：最终远端验证**

```powershell
gh repo view daanaagua/FolioLoom --json url,visibility,defaultBranchRef,licenseInfo
gh release view v1.0.0 --repo daanaagua/FolioLoom --json name,tagName,url,isDraft,isPrerelease
gh run list --repo daanaagua/FolioLoom --workflow "FolioLoom CI" --limit 3
```

预期：仓库公开、MIT 可识别、Release 不是 draft/prerelease、CI 成功。

## Task 9：回写私有仓库的发布指针

**文件：**

- 修改：`README.md`（仅当最终 URL 与已写内容不同）
- 不添加公开仓库 remote 到私有仓库，避免误推完整历史。

- [ ] **步骤 1：检查私有 README 的公开链接**

```powershell
Set-Location D:\llm\小说翻译
rg -n "github.com/daanaagua/(FolioLoom|novel-translate-public)" README.md
```

若 README 已使用最终地址，不修改。若仍为旧地址，只替换链接并单独提交。

- [ ] **步骤 2：确认用户修改和私有 remote 未受影响**

```powershell
git status --short
git remote -v
```

预期：原有用户报告修改仍在；`origin` 仍指向私有 `daanaagua/novel-translate`，没有把私有历史连接到公开仓库。

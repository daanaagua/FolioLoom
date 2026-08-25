# FolioLoom Windows 目录便携版实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 保留单文件便携版，并新增可直接解压运行、根目录包含 `FolioLoom.exe` 的 Windows x64 目录版 ZIP。

**架构：** electron-builder 继续负责构造签名边界一致的 `win-unpacked`。一个小型 Node/TypeScript 发布脚本只负责验证必需文件、调用 Windows 自带的 .NET ZIP 实现压缩目录并重新读取 ZIP 清单验收；npm 命令分别提供单文件、目录和双产物入口。

**技术栈：** Node.js 24、TypeScript、Electron Builder、PowerShell/.NET `System.IO.Compression.ZipFile`、yauzl、Node Test Runner。

---

## 文件结构

- 创建：`translator-v5/scripts/package-folder-portable.ts`——目录版 ZIP 的验证、压缩和清单复核。
- 创建：`translator-v5/test/folder-portable-package.test.ts`——源目录边界、ZIP 根结构和覆盖旧产物回归。
- 修改：`translator-v5/package.json`——增加 `desktop:dist:exe`、`desktop:dist:folder` 并调整 `desktop:dist`。
- 修改：`translator-v5/test/desktop-build-config.test.ts`——锁定三条发布命令及打包脚本入口。
- 修改：`translator-v5/README.md`——说明两种便携产物和目录版使用方法。

### 任务 1：锁定目录版归档契约

- [x] **步骤 1：编写失败的目录归档测试**

在 `translator-v5/test/folder-portable-package.test.ts` 中建立临时 `win-unpacked`，覆盖：

```ts
await assert.rejects(
  createFolderPortableArchive({ sourceDir, outputZip }),
  /FolioLoom\.exe/,
);

writeFileSync(join(sourceDir, "FolioLoom.exe"), "exe");
mkdirSync(join(sourceDir, "resources"), { recursive: true });
writeFileSync(join(sourceDir, "resources", "app.asar"), "asar");
await createFolderPortableArchive({ sourceDir, outputZip });
assert.deepEqual(await listZipEntries(outputZip), [
  "FolioLoom.exe",
  "resources/app.asar",
]);
```

第二次调用前把旧 ZIP 写成无效内容，确认脚本会原子替换而不是追加旧归档。

- [x] **步骤 2：运行测试并确认失败**

运行：

```powershell
node --test --import tsx test/folder-portable-package.test.ts
```

预期：FAIL，提示不存在 `scripts/package-folder-portable.ts` 或导出函数。

- [x] **步骤 3：实现最小目录压缩脚本**

`package-folder-portable.ts` 导出：

```ts
export interface FolderPortableArchiveOptions {
  sourceDir: string;
  outputZip: string;
}

export async function listZipEntries(zipPath: string): Promise<string[]>;
export async function createFolderPortableArchive(
  options: FolderPortableArchiveOptions,
): Promise<void>;
```

实现必须：

- 使用 `realpathSync` 和固定必需文件检查源目录；
- 输出到同目录临时 ZIP，再以 `renameSync` 替换最终 ZIP；
- 通过 `spawnSync("powershell.exe", [...])` 的独立参数传递路径，不拼接用户输入；
- 使用 `ZipFile.CreateFromDirectory(source, temp, Optimal, false)`，确保 ZIP 根目录不包含 `win-unpacked/`；
- 用 yauzl 重新读取条目，拒绝绝对路径、盘符、`..` 和反斜杠路径；
- 确认 `FolioLoom.exe` 与 `resources/app.asar` 均在 ZIP 中；
- 失败时删除临时 ZIP，并保留已有正式 ZIP。

CLI 默认读取：

```ts
sourceDir = resolve("release", "win-unpacked");
outputZip = resolve("release", "FolioLoom-portable-win-x64.zip");
```

- [x] **步骤 4：运行目录归档测试并确认通过**

运行：

```powershell
node --test --import tsx test/folder-portable-package.test.ts
```

预期：全部 PASS。

- [x] **步骤 5：提交目录归档实现**

```powershell
git add translator-v5/scripts/package-folder-portable.ts translator-v5/test/folder-portable-package.test.ts
git commit -m "feat: package folder portable archive"
```

### 任务 2：接入双产物发布命令

- [x] **步骤 1：更新配置测试并确认失败**

修改 `translator-v5/test/desktop-build-config.test.ts`，精确断言：

```ts
assert.equal(
  scripts["desktop:dist:exe"],
  "npm run desktop:build && electron-builder --win portable --x64",
);
assert.equal(
  scripts["desktop:dist:folder"],
  "npm run desktop:build && electron-builder --win --dir --x64 && tsx scripts/package-folder-portable.ts",
);
assert.equal(
  scripts["desktop:dist"],
  "npm run desktop:build && electron-builder --win portable --x64 && tsx scripts/package-folder-portable.ts",
);
```

运行：

```powershell
node --test --import tsx test/desktop-build-config.test.ts
```

预期：FAIL，缺少新脚本且 `desktop:dist` 仍是旧值。

- [x] **步骤 2：修改 package scripts**

在 `translator-v5/package.json` 中加入上述三条命令。`desktop:dist` 复用 portable 构建产生的 `win-unpacked`，因此只执行一次 Electron 打包；`desktop:dist:folder` 使用明确的 `--dir` 目标。

- [x] **步骤 3：运行配置测试与类型检查**

运行：

```powershell
node --test --import tsx test/desktop-build-config.test.ts
npm run typecheck
```

预期：全部 PASS。

- [x] **步骤 4：提交发布命令**

```powershell
git add translator-v5/package.json translator-v5/test/desktop-build-config.test.ts
git commit -m "build: add folder portable distribution"
```

### 任务 3：文档、真实打包与冷启动验收

- [x] **步骤 1：更新使用文档**

修改 `translator-v5/README.md`，明确：

- `desktop:dist` 同时生成 `.exe` 和 `.zip`；
- 普通用户优先解压 ZIP 并双击根目录的 `FolioLoom.exe`；
- 目录内的 DLL、`resources`、`locales` 都是运行必需内容，不应单独移动 EXE。

- [x] **步骤 2：运行完整验证**

运行：

```powershell
npm test
npm run typecheck
npm run desktop:test
npm run desktop:typecheck
npm run desktop:dist
```

预期：测试、类型检查、生产构建和两种产物生成全部通过。

- [x] **步骤 3：解压并验证归档结构**

将 `release/FolioLoom-portable-win-x64.zip` 解压到新的临时目录，断言根目录存在：

```text
FolioLoom.exe
resources/app.asar
locales/
```

并确认 ZIP 不含 `win-unpacked/` 顶层目录。

- [x] **步骤 4：冷启动目录版**

从临时解压目录启动 `FolioLoom.exe`，确认主窗口出现、标题和主要工作区正常显示，然后关闭窗口并确认 `FolioLoom` 进程数为零。

- [x] **步骤 5：最终检查并提交**

运行：

```powershell
git diff --check
git status --short
```

将计划复选框改为完成，提交 README、计划和最终调整：

```powershell
git add translator-v5/README.md docs/superpowers/plans/2026-07-23-folder-portable-package.md
git commit -m "docs: document folder portable release"
```

# FolioLoom Windows 目录便携版打包设计

日期：2026-07-23

## 目标

在保留现有单文件便携版的同时，提供一个与 Electron `win-unpacked` 内容一致、可直接解压运行的 Windows x64 目录版压缩包：

- 单文件版：`release/FolioLoom-portable-win-x64.exe`
- 目录版：`release/FolioLoom-portable-win-x64.zip`
- 目录版入口：解压后双击 `FolioLoom.exe`

目录版用于主要分发。用户不需要安装，也不需要手动补充 DLL、语言包或资源文件。

## 打包流程

1. 运行桌面生产构建。
2. 使用 electron-builder 的 `dir` 目标生成 `release/win-unpacked`。
3. 删除旧的同名目录版 ZIP，避免压缩工具产生嵌套或追加内容。
4. 将 `win-unpacked` 内部内容直接压缩进 `FolioLoom-portable-win-x64.zip`。
5. 保留现有 portable 单文件打包命令，并增加一个同时生成两种产物的发布命令。

ZIP 根目录直接包含 `FolioLoom.exe`、`resources`、`locales` 和依赖文件，不额外包一层 `win-unpacked` 目录。

## 命令设计

- `desktop:dist:exe`：生成现有单文件便携版。
- `desktop:dist:folder`：生成并压缩目录便携版。
- `desktop:dist`：一次构建并生成两种发布产物。

压缩过程由仓库内脚本完成，明确校验：

- `win-unpacked/FolioLoom.exe` 存在。
- `resources/app.asar` 存在。
- ZIP 成功生成且非空。
- ZIP 中的路径不得逃逸，也不得遗漏目录结构。

## 验收

1. 全量桌面测试、类型检查和生产构建通过。
2. `desktop:dist` 同时生成 EXE 和 ZIP。
3. ZIP 解压后根目录直接可见 `FolioLoom.exe`。
4. 从临时解压目录冷启动 FolioLoom，主窗口正常显示。
5. 关闭测试窗口后无残留 FolioLoom 进程。

## 范围外

- 不制作传统安装向导。
- 不改变 GUI、项目数据位置或自动更新机制。
- 不承诺单个可执行文件；目录版必须携带 Electron 运行时文件。

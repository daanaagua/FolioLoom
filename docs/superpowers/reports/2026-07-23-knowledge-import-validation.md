# 知识导入验证报告

日期：2026-07-23
分支：`feat/folioloom-desktop`
运行环境：Windows 10、Node.js 24.14.1、FolioLoom 1.0.0

## 依赖与审计

- 主要解析依赖：`csv-parse 7.0.1`、`yaml 2.9.0`、`exceljs 4.4.0`、`yauzl 3.4.x`。
- `npm audit --omit=dev --json`：0 high、0 critical、2 moderate。
- 两项 moderate 来自 `exceljs 4.4.0 → uuid 8.3.2` 的同一 buffer bounds advisory。FolioLoom 不调用受影响的 namespace/buffer UUID 接口；ExcelJS 在当前路径只用 `uuid.v4()`。npm 给出的“修复”是回退到 ExcelJS 3.4.0，不是可接受的安全升级，因此本轮不做破坏性降级。
- 导入路径不执行公式、宏、外部关系、YAML 类型构造器或任意 SQL。

## 四格式语义等价

命令：

```powershell
node --test --import tsx --test-name-pattern="four formats produce identical knowledge" test/knowledge-import-service.test.ts
```

结果：1/1 通过。相同的 20 条 term 记录从 JSON、YAML、CSV 和 XLSX 导入后，除文件哈希、batch ID 与源位置外，以下内容完全一致：

- normalized subject 与对象类型；
- active payload；
- authority origin/scope/ownedFields；
- revision 数量；
- snapshot 内容与 generation。

官方 JSON 模板和程序生成的官方 XLSX 模板均能被识别；GUI 仍展示映射摘要和预览，不绕过用户确认。

## 冲突、重启、幂等与撤销

联合命令：

```powershell
node --test --import tsx test/knowledge-import-service.test.ts test/fault-injection.test.ts test/knowledge-commands.test.ts test/lossless-audit.test.ts
```

结果：53/53 通过，覆盖：

- staging 分页、决策持久化和显式丢弃；
- 大小写等价 subject 绑定到已有规范实体；
- keep existing、use imported、merge as alias、create separate 与 skip；
- 相同 batch 重试不重复生成 revision；
- committed batch 不会被误当作可恢复 staging；
- discarded 与 rolled-back batch 可用同一源文件重新 staging；
- 整批提交、整批撤销与三处故障注入均保持单事务；
- 源文件在 inspect 后变化会拒绝 staging；
- generation 或 catalog generation 陈旧时拒绝覆盖。

真实 Electron 路径另外完成：

1. 官方 JSON 模板与现有 `archon` 产生冲突；
2. 选择“并为别名”后提交；
3. 撤销整批导入；
4. 再次 staging 后关闭应用；
5. 重启并恢复同一 batch；
6. 丢弃 staging 后重新导入同一文件。

上述路径均完成，恢复页切换后焦点停留在向导内。

## 恶意输入与 XLSX 安全

命令：

```powershell
node --test --import tsx test/knowledge-import-input-policy.test.ts test/knowledge-import-json-yaml.test.ts test/knowledge-import-csv-xlsx.test.ts test/desktop-main-security.test.ts
```

结果：23/23 通过。已验证：

- JSON/YAML 深度、重复键、`__proto__`、YAML alias expansion；
- 100,001 条 CSV、257 列、超限单元格和非 UTF-8 显式编码确认；
- 损坏 XLSX、ZIP bomb、路径穿越、宏、公式与外部 relationship；
- renderer 不能提供文件路径、数据库路径、SQL 或 generic IPC；
- 主进程只返回 opaque pending/batch ID 和有界预览。

所有拒绝都发生在正式知识写入前，测试数据库没有部分 batch 或 revision。

## 100,000 行 CSV 性能

命令：

```powershell
npx tsx scripts/validate-knowledge-import-performance.ts
```

本机结果：

| 指标 | 结果 |
|---|---:|
| 数据记录 | 100,000 |
| staging 时间 | 5,562 ms |
| 吞吐 | 17,979 条/秒 |
| staging 后 RSS | 323,309,568 bytes |
| 进程峰值 RSS（Windows） | 338,536 KiB |
| SQLite 大小 | 122,277,888 bytes |

CSV 上限按数据记录计数，标题行不占用 100,000 条额度。解析与规范化使用流式读取和磁盘 staging；renderer 只接收最多 100 条的有界页面。

## 非 P0/P1 限制

- 50,000 条全新知识的单事务提交在本机约需 174 秒；提交期间数据库保持原子，但超大批次仍需要明确进度提示。普通术语表远小于该规模。
- 通用 `LIKE`/payload 模糊搜索在 50,000 条下约 887 ms，诊断汇总约 613 ms；两者在 GUI 中异步加载，不阻塞 renderer 线程。
- 不支持 `.xls`、`.xlsm`、公式计算或直接 SQL 导入；这是安全边界，不属于待修缺陷。
- 导入后不会自动进行全书证据扫描；只有用户希望补全位置证据时才另行运行离线索引。

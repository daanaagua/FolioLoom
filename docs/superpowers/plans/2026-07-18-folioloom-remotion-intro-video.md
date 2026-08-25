# FolioLoom Remotion 项目介绍视频实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 FolioLoom 仓库中增加一个可开源的 Remotion 视频工程，用本机外部素材生成约 4 分 20 秒的 1080p 项目介绍视频和 SRT 字幕。

**架构：** `video/` 只保存 React/Remotion 源码、公开文案、测试和空白配置；真实 GitHub 长图、Fish Audio 曼波 WAV、小说短句和最终输出留在仓库外。素材准备阶段生成不含绝对路径的本地清单，正式渲染完全离线，视频总帧数由真实 WAV 时长计算。

**技术栈：** Node.js 24、TypeScript 7、React 19、Remotion 4.0.491、Playwright 1.61.1、Node 内置测试运行器、PowerShell。

---

## 参考资料

- 设计规格：`docs/superpowers/specs/2026-07-18-folioloom-remotion-intro-video-design.md`
- FolioLoom README：`README.md`
- V5 提丰实验：`docs/superpowers/reports/2026-07-17-v5-agent-kernel-pilot.md`
- Fish Audio 曼波声音：`https://fish.audio/zh-CN/m/0f08cacd3e354471a4b94dd00b4cc4a3/`
- Remotion `calculateMetadata`：`https://www.remotion.dev/docs/calculate-metadata`
- Playwright 全页截图：`https://playwright.dev/docs/screenshots`

## 文件结构与职责

### 仓库内

- `video/package.json`：视频工程依赖和命令入口。
- `video/tsconfig.json`：同时覆盖浏览器端场景、Node 脚本和测试。
- `video/src/index.ts`：Remotion 注册入口。
- `video/src/Root.tsx`：组合注册和动态 metadata。
- `video/src/FolioLoomIntro.tsx`：只负责按时间表装配场景、音频和字幕。
- `video/src/types.ts`：配置、素材清单、文案和时间表的共享类型。
- `video/src/content.ts`：已批准的第一人称文案与字幕短语。
- `video/src/timeline.ts`：从音频时长构建连续帧区间和 SRT cue。
- `video/src/theme.ts`：颜色、字体、间距、安全区和动效参数。
- `video/src/components/`：字幕、GitHub 遮罩、文字证据、场景标题等小组件。
- `video/src/scenes/`：十一种可独立预览的场景。
- `video/scripts/config.ts`：只在 Node 侧读取并验证本机配置。
- `video/scripts/media.ts`：解析 PCM/IEEE-float WAV 时长和 PNG 尺寸。
- `video/scripts/prepare-assets.ts`：复制、哈希并生成公开相对路径清单。
- `video/scripts/preflight.ts`：渲染前执行完整性、隐私和时长硬检查。
- `video/scripts/capture-github.ts`：按需捕获真实 GitHub 全页长图。
- `video/scripts/export-narration.ts`：将逐场配音文本写到外部素材目录。
- `video/scripts/export-srt.ts`：根据最终时间表导出 SRT。
- `video/scripts/render-keyframes.ts`：渲染每个场景的开头、中段和结尾。
- `video/config/project.local.json.example`：不含密钥的本机配置示例。
- `video/test/`：纯函数测试和测试素材生成器。
- `.gitignore`：忽略本机配置、准备缓存、成片和视频依赖。

### 仓库外

- `D:\llm\qikan4\folioloom-video-assets\github\github-readme.png`
- `D:\llm\qikan4\folioloom-video-assets\voice\*.wav`
- `D:\llm\qikan4\folioloom-video-assets\voice\prompts\*.txt`
- `D:\llm\qikan4\folioloom-video-assets\excerpts\piaton.txt`

---

## Task 1：建立隔离的视频包

**文件：**

- 创建：`video/package.json`
- 创建：`video/tsconfig.json`
- 创建：`video/src/index.ts`
- 创建：`video/src/Root.tsx`
- 创建：`video/src/Placeholder.tsx`
- 修改：`.gitignore`

- [ ] **步骤 1：先写包身份测试**

创建 `video/test/package.test.ts`：

```ts
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

test("video package pins one Remotion release and exposes safe commands", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.name, "folioloom-video");
  assert.equal(pkg.private, true);
  assert.equal(pkg.dependencies.remotion, "4.0.491");
  assert.equal(pkg.devDependencies["@remotion/cli"], "4.0.491");
  assert.match(pkg.scripts.preflight, /scripts\/preflight\.ts/);
  assert.match(pkg.scripts["render:final"], /preflight/);
});
```

- [ ] **步骤 2：运行测试并确认失败**

运行：

```powershell
Set-Location D:\llm\小说翻译\video
node --test test/package.test.ts
```

预期：FAIL，`video/package.json` 不存在。

- [ ] **步骤 3：创建 package、tsconfig 和最小组合**

`video/package.json` 使用以下精确依赖：

```json
{
  "name": "folioloom-video",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "studio": "remotion studio src/index.ts",
    "test": "node --test --import tsx test/**/*.test.ts",
    "typecheck": "tsc --noEmit",
    "capture:github": "tsx scripts/capture-github.ts",
    "export:narration": "tsx scripts/export-narration.ts",
    "prepare:assets": "tsx scripts/prepare-assets.ts",
    "preflight": "tsx scripts/preflight.ts",
    "export:srt": "tsx scripts/export-srt.ts",
    "render:keyframes": "tsx scripts/render-keyframes.ts",
    "render:draft": "npm run preflight && remotion render src/index.ts FolioLoomIntro out/FolioLoom-intro-draft.mp4 --codec=h264 --scale=0.5",
    "render:final": "npm run preflight && remotion render src/index.ts FolioLoomIntro out/FolioLoom-intro.mp4 --codec=h264 --crf=18"
  },
  "dependencies": {
    "react": "19.2.7",
    "react-dom": "19.2.7",
    "remotion": "4.0.491"
  },
  "devDependencies": {
    "@remotion/bundler": "4.0.491",
    "@remotion/cli": "4.0.491",
    "@remotion/renderer": "4.0.491",
    "@types/node": "24.10.1",
    "@types/react": "19.2.17",
    "@types/react-dom": "19.2.3",
    "playwright": "1.61.1",
    "tsx": "4.23.1",
    "typescript": "7.0.2"
  }
}
```

`video/tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "verbatimModuleSyntax": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "scripts/**/*.ts", "test/**/*.ts"]
}
```

最小入口使用以下可直接运行的 150 帧预览组件；Task 10 再将动态 metadata 接入同一个 Composition：

```tsx
// src/index.ts
import {registerRoot} from "remotion";
import {RemotionRoot} from "./Root.js";

registerRoot(RemotionRoot);

// src/Placeholder.tsx
import {AbsoluteFill} from "remotion";

export const Placeholder = () => (
  <AbsoluteFill style={{backgroundColor: "#010409", color: "#f0f6fc", alignItems: "center", justifyContent: "center", fontSize: 72}}>
    FolioLoom
  </AbsoluteFill>
);

// src/Root.tsx
import {Composition} from "remotion";
import {Placeholder} from "./Placeholder.js";

export const RemotionRoot = () => (
  <Composition id="FolioLoomIntro" component={Placeholder} durationInFrames={150} fps={30} width={1920} height={1080} />
);
```

- [ ] **步骤 4：加入精确忽略规则并安装依赖**

在 `.gitignore` 末尾加入：

```gitignore
# FolioLoom Remotion video
video/node_modules/
video/config/project.local.json
video/public/generated/
video/out/
video/.remotion/
```

运行：

```powershell
Set-Location D:\llm\小说翻译\video
npm install
```

预期：生成 `video/package-lock.json`，审计无高危漏洞。

- [ ] **步骤 5：验证最小包**

运行：

```powershell
npm test
npm run typecheck
npx remotion compositions src/index.ts
```

预期：包测试 PASS，类型检查通过，列出 `FolioLoomIntro`。

- [ ] **步骤 6：Commit**

```powershell
git add .gitignore video/package.json video/package-lock.json video/tsconfig.json video/src video/test/package.test.ts
git commit -m "feat(video): scaffold Remotion package"
```

---

## Task 2：定义本机配置和无泄漏素材清单

**文件：**

- 创建：`video/src/types.ts`
- 创建：`video/scripts/config.ts`
- 创建：`video/config/project.local.json.example`
- 创建：`video/test/config.test.ts`

- [ ] **步骤 1：编写配置验证失败测试**

测试必须覆盖：缺少 `assetRoot`、未知键、相对路径、外部素材根目录中的秘密模式，以及生成清单中出现绝对路径。

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {validateLocalConfig, validatePublicManifest} from "../scripts/config.js";

test("local config requires an absolute asset root and exact keys", () => {
  assert.throws(() => validateLocalConfig({assetRoot: "assets"}), /absolute assetRoot/);
  assert.throws(
    () => validateLocalConfig({assetRoot: "D:\\assets", extra: true}),
    /unknown config key/,
  );
});

test("public manifest never carries machine paths or credentials", () => {
  assert.throws(() => validatePublicManifest({schemaVersion: 1, source: "D:\\secret"}), /absolute path/);
  assert.throws(() => validatePublicManifest({schemaVersion: 1, source: "sk-123456789012345678901234"}), /credential/);
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test --import tsx test/config.test.ts`

预期：FAIL，模块不存在。

- [ ] **步骤 3：实现共享类型和严格验证器**

在 `types.ts` 定义：

```ts
export type SceneId =
  | "opening" | "problems" | "ainiee" | "lossless-source"
  | "narrative-memory" | "entity-context" | "parallel-wave"
  | "local-repair" | "workflow" | "piaton" | "roadmap";

export type LocalProjectConfig = {
  assetRoot: string;
  githubScreenshot: string;
  voiceDir: string;
  excerpts: {piaton: string};
};

export type PreparedVoice = {
  sceneId: SceneId;
  file: string;
  durationMs: number;
  sha256: string;
};

export type PreparedAssetManifest = {
  schemaVersion: 1;
  github: {file: string; width: number; height: number; sha256: string; url: string};
  voices: PreparedVoice[];
  excerpts: {piaton: {file: string; sha256: string}};
};
```

`config.ts` 只接受四个顶层键，使用 `path.isAbsolute()` 验证本机根目录；密钥扫描至少覆盖 `sk-[A-Za-z0-9]{24,}`、`Bearer `、`api_key`、`cookie` 和 `authorization`。绝对路径允许存在于被忽略的本机配置，但绝不允许写进 `PreparedAssetManifest`。

- [ ] **步骤 4：添加示例配置**

```json
{
  "assetRoot": "D:\\llm\\qikan4\\folioloom-video-assets",
  "githubScreenshot": "github/github-readme.png",
  "voiceDir": "voice",
  "excerpts": {
    "piaton": "excerpts/piaton.txt"
  }
}
```

- [ ] **步骤 5：运行测试和类型检查**

运行：

```powershell
node --test --import tsx test/config.test.ts
npm run typecheck
```

预期：全部通过。

- [ ] **步骤 6：Commit**

```powershell
git add video/src/types.ts video/scripts/config.ts video/config/project.local.json.example video/test/config.test.ts
git commit -m "feat(video): validate local asset configuration"
```

---

## Task 3：准备 WAV、PNG 和外部素材

**文件：**

- 创建：`video/scripts/media.ts`
- 创建：`video/scripts/prepare-assets.ts`
- 创建：`video/test/media.test.ts`
- 创建：`video/test/prepare-assets.test.ts`
- 创建：`video/test/helpers/wav.ts`

- [ ] **步骤 1：先写 WAV 与 PNG 解析测试**

测试帮助器生成 1 秒、48 kHz、单声道、16-bit PCM WAV；PNG 测试只需构造合法签名和 IHDR 宽高。

```ts
test("reads exact duration from a PCM WAV data chunk", async () => {
  const wav = makePcmWav({sampleRate: 48_000, channels: 1, bitsPerSample: 16, seconds: 1});
  assert.deepEqual(readWavInfo(wav), {durationMs: 1000, sampleRate: 48_000, channels: 1});
});

test("reads PNG dimensions without decoding image pixels", () => {
  assert.deepEqual(readPngDimensions(makePngHeader(1600, 6200)), {width: 1600, height: 6200});
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test --import tsx test/media.test.ts`

预期：FAIL，解析函数不存在。

- [ ] **步骤 3：实现有界媒体解析**

`readWavInfo()` 必须：

- 验证 `RIFF` 和 `WAVE`；
- 遍历 chunk，找到 `fmt ` 与 `data`；
- 只接受 PCM `1` 或 IEEE float `3`；
- 用 `dataSize / byteRate * 1000` 计算时长；
- 拒绝零时长、缺块和越界 chunk。

`readPngDimensions()` 必须验证八字节 PNG 签名以及 IHDR，再读取大端宽高。

- [ ] **步骤 4：先写素材准备失败测试**

```ts
test("prepared manifest uses relative public files and stable hashes", async () => {
  const result = await prepareAssets({configPath, publicDir});
  assert.equal(result.voices.length, 11);
  assert.ok(result.voices.every((voice) => voice.file.startsWith("generated/voice/")));
  assert.ok(JSON.stringify(result).includes(assetRoot) === false);
  assert.match(result.github.sha256, /^[a-f0-9]{64}$/);
});
```

测试临时目录中创建 11 个精确场景名 WAV、一个 1600×6200 PNG 和一个 `piaton.txt`。

- [ ] **步骤 5：实现 `prepareAssets()`**

精确输出：

```text
video/public/generated/github/github-readme.png
video/public/generated/voice/<scene-id>.wav
video/public/generated/excerpts/piaton.txt
video/public/generated/asset-manifest.json
```

复制前删除的只能是已验证位于 `video/public/generated/` 内的旧缓存；不要修改外部素材。每个文件使用 SHA-256，清单中只写 `generated/...` 相对路径。

- [ ] **步骤 6：运行聚焦与完整测试**

```powershell
node --test --import tsx test/media.test.ts test/prepare-assets.test.ts
npm test
npm run typecheck
```

预期：全部通过。

- [ ] **步骤 7：Commit**

```powershell
git add video/scripts/media.ts video/scripts/prepare-assets.ts video/test/media.test.ts video/test/prepare-assets.test.ts video/test/helpers/wav.ts
git commit -m "feat(video): prepare offline render assets"
```

---

## Task 4：锁定文案、音频命名、时间表和 SRT

**文件：**

- 创建：`video/src/content.ts`
- 创建：`video/src/timeline.ts`
- 创建：`video/scripts/export-narration.ts`
- 创建：`video/scripts/export-srt.ts`
- 创建：`video/test/timeline.test.ts`
- 创建：`video/test/srt.test.ts`

- [ ] **步骤 1：编写时间表性质测试**

```ts
test("timeline is continuous and audio-driven", () => {
  const timeline = buildTimeline(content, manifest, 30);
  assert.equal(timeline[0].from, 0);
  for (let i = 1; i < timeline.length; i++) {
    assert.equal(timeline[i].from, timeline[i - 1].from + timeline[i - 1].durationInFrames);
  }
  assert.equal(timeline.at(-1)!.to, timeline.reduce((sum, item) => sum + item.durationInFrames, 0));
});

test("caption cues stay inside their own scene", () => {
  for (const scene of buildTimeline(content, manifest, 30)) {
    assert.ok(scene.captions.every((cue) => cue.from >= scene.from && cue.to <= scene.to));
  }
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test --import tsx test/timeline.test.ts`

预期：FAIL，`content` 和 `buildTimeline` 不存在。

- [ ] **步骤 3：定义十一段正式内容**

`content.ts` 中的顺序固定为：

```ts
export const CONTENT: readonly SceneContent[] = [
  {id: "opening", voiceFile: "opening.wav", narration: "我原本只是想用 AI 翻几本没有中文版的长篇小说……", captions: ["模型能翻好一句话", "却不一定能翻好一整本书"]},
  {id: "problems", voiceFile: "problems.wav", narration: "同一个名字会在不同分块里变成几种译法……", captions: ["译名漂移", "人物关系误认", "只翻字面", "文风失控"]},
  {id: "ainiee", voiceFile: "ainiee.wav", narration: "AiNiee 很适合通用文件、游戏文本和批量翻译……", captions: ["适用问题不同", "长篇叙事需要另一层工程"]},
  {id: "lossless-source", voiceFile: "lossless-source.wav", narration: "第一件事，是先把原文登记清楚……", captions: ["原文不能偷偷少", "译完逐块对账"]},
  {id: "narrative-memory", voiceFile: "narrative-memory.wav", narration: "我没有把整本书的背景一次塞给模型……", captions: ["翻到哪里", "记忆开到哪里"]},
  {id: "entity-context", voiceFile: "entity-context.wav", narration: "需要统一的是同一个人物，而不是把每个词锁死……", captions: ["人物凭证据合并", "称呼随语境变化"]},
  {id: "parallel-wave", voiceFile: "parallel-wave.wav", narration: "并行翻译可以提速，但不能让每一块各自发明……", captions: ["可以一起干活", "不能各自发明"]},
  {id: "local-repair", voiceFile: "local-repair.wav", narration: "每段翻完以后，程序先检查能够确定的问题……", captions: ["哪里坏了", "只修哪里"]},
  {id: "workflow", voiceFile: "workflow.wav", narration: "实际使用时，我先导入文本，检查原文，再只试译一个窗口……", captions: ["导入", "检查", "试译", "继续", "审计导出"]},
  {id: "piaton", voiceFile: "piaton.wav", narration: PIATON_NARRATION, captions: ["提丰移植到皮亚顿身上", "皮亚顿仍控制心跳", "两个意识共用一具身体", "主角攻击皮亚顿", "提丰随之死亡"]},
  {id: "roadmap", voiceFile: "roadmap.wav", narration: "FolioLoom 现在已经公开在 GitHub……", captions: ["接入自己的模型 API", "GUI", "更多 API", "Galgame / MTool / 更多格式"]},
] as const;
```

`PIATON_NARRATION` 必须逐字采用批准规格第 4.6 节，不使用“塞万里安”，统一说“主角”。完整 opening、作者身份说明、AiNiee 比较、五项设计和结尾同样逐字从规格移入，不能在实现时重新营销化改写。

- [ ] **步骤 4：实现音频驱动时间表**

规则：

- `leadInFrames=12`，`tailFrames=18`；
- `audioFrames=Math.ceil(durationMs / 1000 * fps)`；
- 场景总长为三者之和；
- 字幕按去标点后的可见字符数分配音频区间，单条最短 18 帧；
- 因四舍五入产生的差额全部交给最后一条 cue；
- 总时长必须位于 7,500–9,000 帧，即 250–300 秒。

- [ ] **步骤 5：实现 narration 和 SRT 导出**

`export-narration.ts` 读取本机配置，把十一段 UTF-8 文本写入 `<assetRoot>/voice/prompts/<scene-id>.txt`。

`export-srt.ts` 读取准备清单和时间表，输出 `video/out/FolioLoom-intro.srt`；时间格式严格为 `HH:MM:SS,mmm`。

- [ ] **步骤 6：验证 SRT**

测试断言 cue 编号连续、时间单调、最后一个 cue 不晚于视频总时长，并确认中文文本没有 HTML 或系统 JSON。

运行：

```powershell
node --test --import tsx test/timeline.test.ts test/srt.test.ts
npm run typecheck
```

- [ ] **步骤 7：Commit**

```powershell
git add video/src/content.ts video/src/timeline.ts video/scripts/export-narration.ts video/scripts/export-srt.ts video/test/timeline.test.ts video/test/srt.test.ts
git commit -m "feat(video): define narration and audio timeline"
```

---

## Task 5：建立统一的视觉基础组件

**文件：**

- 创建：`video/src/theme.ts`
- 创建：`video/src/components/SceneFrame.tsx`
- 创建：`video/src/components/Subtitle.tsx`
- 创建：`video/src/components/EvidenceText.tsx`
- 创建：`video/src/components/GithubViewport.tsx`
- 创建：`video/test/theme.test.ts`

- [ ] **步骤 1：先写安全区和主题测试**

```ts
test("theme keeps subtitles inside 1080p safe area", () => {
  assert.equal(THEME.width, 1920);
  assert.equal(THEME.height, 1080);
  assert.ok(THEME.safe.left >= 96 && THEME.safe.right >= 96);
  assert.ok(THEME.subtitle.bottom >= 72);
  assert.ok(THEME.subtitle.maxLines <= 2);
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test --import tsx test/theme.test.ts`

预期：FAIL，主题不存在。

- [ ] **步骤 3：实现主题与基础组件**

主题固定：

```ts
export const THEME = {
  width: 1920,
  height: 1080,
  fps: 30,
  colors: {bg: "#010409", panel: "#0d1117", ink: "#f0f6fc", muted: "#8b949e", blue: "#58a6ff", coral: "#ff7b72", green: "#3fb950", paper: "#f3ead7"},
  fonts: {sans: '"Microsoft YaHei", "Noto Sans CJK SC", sans-serif', serif: 'Georgia, "Songti SC", serif', mono: 'Consolas, ui-monospace, monospace'},
  safe: {left: 120, right: 120, top: 72, bottom: 72},
  subtitle: {bottom: 82, maxWidth: 1460, maxLines: 2},
} as const;
```

所有组件仅使用 `useCurrentFrame()`、`interpolate()` 和 `spring()` 驱动动画；禁止 CSS 无限动画，以保证任意帧可重复渲染。

- [ ] **步骤 4：实现 GitHub 长图视窗**

`GithubViewport` 接收 `{src, imageWidth, imageHeight, scrollFrom, scrollTo, focus}`，用 `<Img>` 和遮罩移动长图。滚动值必须 clamp 到 `0..imageHeight-visibleHeight`，越界直接抛错。

- [ ] **步骤 5：运行测试和类型检查**

```powershell
node --test --import tsx test/theme.test.ts
npm run typecheck
```

- [ ] **步骤 6：Commit**

```powershell
git add video/src/theme.ts video/src/components video/test/theme.test.ts
git commit -m "feat(video): add restrained motion design primitives"
```

---

## Task 6：捕获并复用真实 GitHub 公开页

**文件：**

- 创建：`video/scripts/capture-github.ts`
- 创建：`video/test/capture-config.test.ts`

- [ ] **步骤 1：先写捕获选项测试**

把纯函数 `githubCaptureOptions()` 与浏览器执行分开测试：

```ts
test("GitHub capture is deterministic and full-page", () => {
  assert.deepEqual(githubCaptureOptions(), {
    url: "https://github.com/daanaagua/FolioLoom",
    viewport: {width: 1600, height: 1000},
    deviceScaleFactor: 1,
    colorScheme: "dark",
    fullPage: true,
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test --import tsx test/capture-config.test.ts`

预期：FAIL，函数不存在。

- [ ] **步骤 3：实现 Playwright 捕获**

脚本必须：

1. 读取本机配置；
2. 启动 headless Chromium；
3. 使用 1600×1000 viewport 和 dark color scheme；
4. 访问唯一允许的 URL `https://github.com/daanaagua/FolioLoom`；
5. 等待 `article.markdown-body` 和 `document.fonts.ready`；
6. 注入样式隐藏 cookie/悬浮提示，不改 README 正文；
7. `page.screenshot({fullPage: true})` 写入外部 `github-readme.png`；
8. 在 `finally` 中始终关闭 browser；
9. 打印输出路径和尺寸，不打印 Cookie 或请求头。

- [ ] **步骤 4：安装 Chromium 并真实捕获**

```powershell
Set-Location D:\llm\小说翻译\video
npx playwright install chromium
Copy-Item config\project.local.json.example config\project.local.json
npm run capture:github
```

预期：外部素材目录生成 PNG，宽度至少 1600，高度大于 3000。

- [ ] **步骤 5：测试和 Commit**

```powershell
node --test --import tsx test/capture-config.test.ts
git add video/scripts/capture-github.ts video/test/capture-config.test.ts
git commit -m "feat(video): capture the public GitHub page"
```

---

## Task 7：实现开场、问题和 AiNiee 定位场景

**文件：**

- 创建：`video/src/scenes/GithubOpeningScene.tsx`
- 创建：`video/src/scenes/ProblemMontageScene.tsx`
- 创建：`video/src/scenes/AinieePositioningScene.tsx`
- 创建：`video/src/scenes/scene-registry.ts`
- 创建：`video/test/scene-registry.test.ts`

- [ ] **步骤 1：先写场景注册测试**

```ts
test("opening scenes are registered once and in narrative order", () => {
  assert.deepEqual(SCENE_REGISTRY.slice(0, 3).map((scene) => scene.id), ["opening", "problems", "ainiee"]);
  assert.equal(new Set(SCENE_REGISTRY.map((scene) => scene.id)).size, SCENE_REGISTRY.length);
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test --import tsx test/scene-registry.test.ts`

预期：FAIL，场景注册表不存在。

- [ ] **步骤 3：实现 GitHub 开场**

开场从长图顶部开始，18 秒内完成三次焦点：仓库名、英文简介、README 的 V1.0 能力。叠加的唯一主标题为“为什么翻一本小说，要自己造一套引擎？”。不使用 logo 飞入或粒子背景。

- [ ] **步骤 4：实现四问题蒙太奇**

用四条文本在同一页面上依次出现：

```ts
const FAILURES = [
  ["同一个名字", "三种译法"],
  ["同一个人", "被当成几个人"],
  ["字面翻对", "意思仍然错"],
  ["每段都通顺", "整本书的声音却散了"],
] as const;
```

动画为旧译文字轻微错位、证据文字重新对齐；不使用红色警告卡片连播。

- [ ] **步骤 5：实现 AiNiee 定位差异**

画面只展示两个范围圆：左侧“批量文件 / 游戏文本 / 多格式”，右侧“长篇叙事连续性”。重叠区域写“模型调用、术语、断点继续”；FolioLoom 特有关注区写“按位置记忆、实体证据、并行一致性”。不得写“解决不了”或“落后”。

- [ ] **步骤 6：验证和 Commit**

```powershell
node --test --import tsx test/scene-registry.test.ts
npm run typecheck
git add video/src/scenes video/test/scene-registry.test.ts
git commit -m "feat(video): animate the problem and positioning story"
```

---

## Task 8：实现五项核心设计和实机流程

**文件：**

- 创建：`video/src/scenes/LosslessSourceScene.tsx`
- 创建：`video/src/scenes/NarrativeMemoryScene.tsx`
- 创建：`video/src/scenes/EntityContextScene.tsx`
- 创建：`video/src/scenes/ParallelWaveScene.tsx`
- 创建：`video/src/scenes/LocalRepairScene.tsx`
- 创建：`video/src/scenes/WorkflowScene.tsx`
- 修改：`video/src/scenes/scene-registry.ts`
- 修改：`video/test/scene-registry.test.ts`

- [ ] **步骤 1：扩展注册测试并确认失败**

预期 ID 顺序：

```ts
["lossless-source", "narrative-memory", "entity-context", "parallel-wave", "local-repair", "workflow"]
```

运行后预期 FAIL，注册表尚缺六项。

- [ ] **步骤 2：实现原文登记和按位置记忆**

- `LosslessSourceScene`：一整段文字分成编号条带，故意抽走中间一条形成空洞，随后审计线定位缺口并复原；
- `NarrativeMemoryScene`：当前段落保持纸张质感，只有三条相关旧事从背景浮现，未来信息停在遮罩之外。

- [ ] **步骤 3：实现人物语境与并行波次**

- `EntityContextScene`：多个表面称呼沿细证据线汇聚到一个实体名；职业称呼保留三个不同中文语境，不画人物；
- `ParallelWaveScene`：一个共享锚点分出三条平行文本流，完成后按 A、B、C 原顺序合拢；B 的局部失败不改变 A/C。

- [ ] **步骤 4：实现局部返修与实机流程**

- `LocalRepairScene`：只抽出失败句子，修复后嵌回原位置，其他行保持像素位置不动；
- `WorkflowScene`：终端只显示 `init → doctor → run --max-windows 1 → run → audit/export`，每条命令只保留项目名，不出现本机密钥路径。

- [ ] **步骤 5：验证注册、类型和禁用粗糙 SVG**

测试读取 `PiatonCaseScene` 之外的注册模块，确保所有 ID 完整。另用 `rg` 人工检查：

```powershell
rg -n "<svg|<path|<circle" video/src/scenes
```

预期：没有人物或身体 SVG；若使用纯装饰 SVG，也应删除并改为 CSS/文本布局。

- [ ] **步骤 6：Commit**

```powershell
git add video/src/scenes video/test/scene-registry.test.ts
git commit -m "feat(video): explain FolioLoom with motion scenes"
```

---

## Task 9：实现皮亚顿案例、结果边界和结尾

**文件：**

- 创建：`video/src/scenes/PiatonCaseScene.tsx`
- 创建：`video/src/scenes/RoadmapScene.tsx`
- 修改：`video/src/scenes/scene-registry.ts`
- 创建：`video/test/piaton-scene.test.ts`

- [ ] **步骤 1：先写内容约束测试**

```ts
test("Piaton case is self-contained and uses the generic protagonist label", () => {
  const text = CONTENT.find((scene) => scene.id === "piaton")!.narration;
  assert.match(text, /双头人/);
  assert.match(text, /提丰.*移植.*皮亚顿/s);
  assert.match(text, /心跳/);
  assert.match(text, /主角/);
  assert.doesNotMatch(text, /前文|塞万里安|SVG/);
});
```

- [ ] **步骤 2：运行测试确认当前内容符合，场景仍缺失**

在同一测试中断言注册表含 `piaton` 和 `roadmap`；预期因场景未实现而 FAIL。

- [ ] **步骤 3：实现纯文字证据动画**

`PiatonCaseScene` 只呈现三步：

1. “提丰把自己的头移植到皮亚顿身上”；
2. “手术未完成：皮亚顿仍活着，并维持心跳”；
3. “主角攻击皮亚顿 → 心脏停止 → 提丰死亡”。

背景短暂显示外部 `piaton.txt` 的三句短引文，但配音不复述原文。不得绘制身体、头颅、人物剪影或 SVG。

- [ ] **步骤 4：实现真实数据和边界说明**

皮亚顿段结束后只显示 6 秒数据：

```text
同一局部目标：3h25 → 4m24
5 / 5 文本块落盘
最终校验失败：0
```

底部小字固定为“局部冷启动实测，不代表全书固定速度”。随后显示“一次真实五段盲评：两胜 / 一负 / 一平 / 一项都不理想”。

- [ ] **步骤 5：实现路线图和 CTA**

回到 GitHub README，滚动到快速开始与限制。依次高亮“自己的模型 API”“GUI”“更多 API”“Galgame / MTool / 更多格式”，最后停在仓库 URL，不使用“关注、三连”等营销按钮。

- [ ] **步骤 6：验证和 Commit**

```powershell
node --test --import tsx test/piaton-scene.test.ts test/scene-registry.test.ts
npm run typecheck
git add video/src/scenes video/test/piaton-scene.test.ts
git commit -m "feat(video): add the Piaton case and honest results"
```

---

## Task 10：装配完整组合、音频和字幕

**文件：**

- 修改：`video/src/Root.tsx`
- 创建：`video/src/FolioLoomIntro.tsx`
- 创建：`video/src/components/SceneAudio.tsx`
- 创建：`video/src/components/CaptionLayer.tsx`
- 创建：`video/src/assets.ts`
- 创建：`video/test/composition.test.ts`

- [ ] **步骤 1：先写 metadata 和总帧测试**

```ts
test("composition metadata matches the prepared audio timeline", async () => {
  const metadata = calculateIntroMetadata(manifest);
  const timeline = buildTimeline(CONTENT, manifest, 30);
  assert.equal(metadata.durationInFrames, timeline.at(-1)!.to);
  assert.equal(metadata.width, 1920);
  assert.equal(metadata.height, 1080);
  assert.equal(metadata.fps, 30);
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test --import tsx test/composition.test.ts`

预期：FAIL，组合 metadata 函数不存在。

- [ ] **步骤 3：实现 manifest 加载和动态 metadata**

`assets.ts` 使用 `fetch(staticFile("generated/asset-manifest.json"))`，校验后返回清单。`Root.tsx` 的 `calculateMetadata` 读取清单并返回：

```ts
return {
  durationInFrames: timeline.at(-1)!.to,
  fps: 30,
  width: 1920,
  height: 1080,
  defaultCodec: "h264",
  defaultPixelFormat: "yuv420p",
  props: {manifest},
};
```

不得在 metadata 阶段访问外网。

- [ ] **步骤 4：实现 `<Series>` 场景装配**

`FolioLoomIntro` 遍历 timeline，每个 `<Series.Sequence durationInFrames>` 内渲染注册场景、对应 `<Html5Audio src={staticFile(voice.file)} />` 和当前场景字幕。场景组件只接收局部帧数、场景总帧数和准备清单。

- [ ] **步骤 5：验证音频和字幕只有一份**

测试断言每个 SceneId 恰好对应一个 voice、一个 registry entry、一个 content entry；缺失或重复均抛错。

运行：

```powershell
node --test --import tsx test/composition.test.ts
npm test
npm run typecheck
```

- [ ] **步骤 6：Commit**

```powershell
git add video/src/Root.tsx video/src/FolioLoomIntro.tsx video/src/components video/src/assets.ts video/test/composition.test.ts
git commit -m "feat(video): compose audio-driven FolioLoom intro"
```

---

## Task 11：加入预检、关键帧和渲染门禁

**文件：**

- 创建：`video/scripts/preflight.ts`
- 创建：`video/scripts/render-keyframes.ts`
- 创建：`video/test/preflight.test.ts`
- 创建：`video/README.md`

- [ ] **步骤 1：先写预检失败矩阵**

测试至少覆盖：

```ts
test("preflight rejects incomplete or unsafe render state", async (t) => {
  await t.test("missing voice", () => assert.rejects(() => preflight(missingVoice), /missing voice/));
  await t.test("zero duration", () => assert.rejects(() => preflight(zeroDuration), /zero duration/));
  await t.test("short GitHub image", () => assert.rejects(() => preflight(shortPng), /GitHub image height/));
  await t.test("absolute path leak", () => assert.rejects(() => preflight(pathLeak), /absolute path/));
  await t.test("credential leak", () => assert.rejects(() => preflight(secretLeak), /credential/));
  await t.test("over five minutes", () => assert.rejects(() => preflight(longVideo), /3-5 minute/));
});

test("sceneKeyframes returns start, middle and end frames", () => {
  assert.deepEqual(sceneKeyframes({ from: 90, durationInFrames: 60 }), [90, 119, 149]);
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test --import tsx test/preflight.test.ts`

预期：FAIL，预检函数不存在。

- [ ] **步骤 3：实现正式渲染硬门禁**

`preflight` 依次执行：本机配置 → 外部文件 → prepared manifest → 11 个 WAV → GitHub PNG → excerpt → timeline → SRT → Git 忽略规则 → 密钥扫描。成功时输出一份不含本机路径的 JSON 摘要；失败退出码非零。

- [ ] **步骤 4：实现关键帧渲染**

`render-keyframes.ts` 导出纯函数 `sceneKeyframes()`，并使用 `@remotion/bundler` 和 `@remotion/renderer` 为每个场景输出三帧：

```text
video/out/keyframes/<scene-id>-start.png
video/out/keyframes/<scene-id>-middle.png
video/out/keyframes/<scene-id>-end.png
```

脚本先运行预检；总计 33 张。任何一张失败则整体退出非零。

- [ ] **步骤 5：写清本机操作文档**

`video/README.md` 只包含：安装、复制本机配置、捕获 GitHub、导出配音文案、在 Fish Audio 生成 WAV、准备素材、Studio、关键帧、草稿、SRT、正式渲染。明确素材和成片不提交。

- [ ] **步骤 6：验证门禁逻辑与构建**

单元测试在临时目录生成合成 WAV 与 PNG，验证预检和 33 个帧号的计算；这一阶段不伪造真实成片，也不调用 GitHub 捕获脚本。运行：

```powershell
npm test
npm run typecheck
```

预期：测试通过，11 个场景各产生 3 个合法帧号，类型检查通过。真实素材上的预检和 33 张关键帧渲染留到 Task 12。

- [ ] **步骤 7：Commit**

```powershell
git add video/scripts/preflight.ts video/scripts/render-keyframes.ts video/test/preflight.test.ts video/README.md
git commit -m "test(video): gate offline Remotion renders"
```

---

## Task 12：生成真实配音、完成视觉验收并导出正片

**文件：**

- 本机生成：`D:\llm\qikan4\folioloom-video-assets\voice\prompts\*.txt`
- 本机生成：`D:\llm\qikan4\folioloom-video-assets\voice\*.wav`
- 本机生成：`video/public/generated/*`（Git 忽略）
- 本机生成：`video/out/FolioLoom-intro-draft.mp4`（Git 忽略）
- 本机生成：`video/out/FolioLoom-intro.mp4`（Git 忽略）
- 本机生成：`video/out/FolioLoom-intro.srt`（Git 忽略）

- [ ] **步骤 1：导出十一段曼波配音文案**

```powershell
Set-Location D:\llm\小说翻译\video
npm run export:narration
```

预期：`voice/prompts/` 下恰好 11 个 UTF-8 TXT，内容与 `CONTENT` 一致。

- [ ] **步骤 2：人工生成曼波 WAV 检查点**

在用户指定的 Fish Audio 页面逐段粘贴 TXT，保持同一声音模型和统一速度，下载为 WAV，并按以下名称保存：

```text
opening.wav
problems.wav
ainiee.wav
lossless-source.wav
narrative-memory.wav
entity-context.wav
parallel-wave.wav
local-repair.wav
workflow.wav
piaton.wav
roadmap.wav
```

如果页面要求登录、商业授权确认或付费，由用户本人处理；不要自动绕过网站权限。十一段齐全前不执行正式渲染。

- [ ] **步骤 3：准备真实素材并执行预检**

```powershell
npm run prepare:assets
npm run preflight
npm run export:srt
```

预期：总时长位于 250–300 秒，清单无绝对路径或密钥，SRT 终点不晚于视频终点。

- [ ] **步骤 4：渲染并逐张检查 33 个关键帧**

```powershell
npm run render:keyframes
```

人工检查：

- GitHub 真实页面没有拉伸或错误裁切；
- 字幕不超过两行且不贴边；
- 五项设计有动态变化，不像静态 PPT；
- 皮亚顿段无人物、身体或头颅 SVG；
- 所有中文在 1080p 缩略预览中仍可读；
- 结尾 GitHub URL 至少停留 3 秒。

- [ ] **步骤 5：渲染 540p 草稿并完成一次内容审看**

```powershell
npm run render:draft
```

完整观看一次，记录音画不同步、停顿不足、字幕切换过快和概念不清处。只修改对应 scene 或 caption weight，不重写已经批准的总体叙事。

- [ ] **步骤 6：重复门禁并渲染正式成片**

```powershell
npm test
npm run typecheck
npm run preflight
npm run export:srt
npm run render:final
```

预期：输出 1920×1080、30 fps、H.264 MP4 和对应 SRT；总时长 3–5 分钟。

- [ ] **步骤 7：最终安全检查**

```powershell
git status --short
git check-ignore video/config/project.local.json video/public/generated/ video/out/
rg -n --hidden -g '!node_modules/**' -g '!public/generated/**' -g '!out/**' "sk-[A-Za-z0-9]{24,}|Bearer [A-Za-z0-9._-]{24,}" .
```

预期：本机配置、缓存和成片全部被忽略；源码无真实密钥；用户原有报告修改仍未被暂存。

- [ ] **步骤 8：Commit 最终源码调整**

只在草稿审看产生源码变更时执行：

```powershell
git add video/src video/test video/README.md
git commit -m "feat(video): finalize FolioLoom intro timing"
```

不得提交 WAV、小说节选、准备缓存、MP4 或 SRT。

---

## 最终验收清单

- [ ] `video/npm test` 全部通过；
- [ ] `video/npm run typecheck` 通过；
- [ ] `npm run preflight` 在真实素材上通过；
- [ ] 33 张关键帧人工检查通过；
- [ ] 540p 草稿完整观看通过；
- [ ] 1080p MP4 和 SRT 成功导出；
- [ ] 成片时长 3–5 分钟；
- [ ] GitHub 是贯穿全片的主舞台；
- [ ] 皮亚顿案例无需原著前情即可理解；
- [ ] 画面不包含粗糙人物 SVG；
- [ ] AiNiee 比较只谈定位差异；
- [ ] 用户明确说自己没有写代码，GPT 承担实现；
- [ ] 局部性能和盲评数据没有被夸大；
- [ ] 结尾邀请观众接入自己的模型 API；
- [ ] GUI、更多 API、Galgame、MTool 和更多格式进入路线图；
- [ ] 本机路径、密钥、小说素材、曼波 WAV 和成片均未进入 Git。

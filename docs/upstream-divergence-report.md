# OpenMAIC fork 与上游 THU-MAIC/OpenMAIC 差异对比报告

| 版本 | 创建日期 | 最后更新 |
|------|----------|----------|
| v1.2.0 | 2026-10-11 | 2026-10-22 |

## 1 大纲

本文回答一个问题：`custom-main` 这个 fork 与上游 `THU-MAIC/OpenMAIC` 现在差了多少、差在哪、要补的话付什么代价。

结论：落后 260 个提交与两个大版本；直接合并将产生 57 处冲突文件；上游 4 项破坏性重构中有 3 项正面取代了本仓的自有实现。

> 2026-10-22 更新：本文记录的同步动作已执行，最新基线为上游 `e19ed13f`（v1.2.1）、314 个提交、60 处冲突。执行过程、验证与遗留风险见 `10 合并执行记录`；第 3–8 节的数字保留为 2026-10-11 的决策基线。

读者：需要在「同步上游 / 继续自研」之间做取舍的人，以及几周后回来复核数字是否仍然成立的维护者。

一级章节按读者的提问顺序切分：`3 结论` → `4 差了多少` → `5/6/7 差在哪`（依次按上游侧、本仓侧、两侧交集三个归属面）→ `8 要不要补` → `9 参考 / 引用` → `10 合并执行记录` → `11 旧课堂验证与残留任务清理` → `12 修订历史`。`9` 与 `12` 是固定槽位，`10/11` 是追加记录。

## 2 目录

- 1 大纲
- 2 目录
- 3 结论：落后 260 个提交、两个大版本，直接合并撞 57 处冲突
  - 3.1 六个承重数字
  - 3.2 三条必须知道的判断
- 4 差了多少：分叉已 59 天，两侧改动面差两个数量级
  - 4.1 时间轴与提交量
  - 4.2 文件与代码行跨度
  - 4.3 版本号与工具链跨度
- 5 差在哪（上游侧）：能力增量集中在导出与媒体，底座换成了服务端优先
  - 5.1 新增能力按功能域分布
  - 5.2 四项破坏性重构
  - 5.3 旧路径到新路径的映射
- 6 差在哪（本仓侧）：105 个私有提交里只有 41 个文件与上游争夺接口
  - 6.1 私有能力清单
  - 6.2 不与上游重叠的治理与工具面
- 7 差在哪（两侧交集）：74 个文件双方都改，合并后留下 8 处死引用
  - 7.1 74 个重叠文件的分布
  - 7.2 57 处合并冲突的构成
  - 7.3 本仓仍在 import 已被上游删除的模块
  - 7.4 三组正面撕裂：认证、边缘路由、配置权威
- 8 要不要补：三条路线的成本、收益与风险（本轮不执行）
- 9 参考 / 引用
  - 9.1 复现命令
  - 9.2 数据口径与取证日期
  - 9.3 未验证项
- 10 合并执行记录（2026-10-22）
  - 10.1 基线与冲突
  - 10.2 解决原则
  - 10.3 兼容层与拆分
  - 10.4 验证
  - 10.5 遗留风险
- 11 旧课堂验证与残留任务清理（2026-10-22）
  - 11.1 存量课堂全量校验
  - 11.2 运行态验证
  - 11.3 发现的迁移缺口
  - 11.4 残留生成任务清理
  - 11.5 验证工具
  - 11.6 未覆盖与遗留风险
- 12 修订历史

## 3 结论：落后 260 个提交、两个大版本，直接合并撞 57 处冲突

### 3.1 六个承重数字

| 数字 | 含义 |
|---|---|
| 260 / 105 | 分叉点之后，上游新增提交数 / 本仓新增私有提交数 |
| 0.3.10 → 1.2.0-rc.1 | 本仓 `package.json` 版本号 → 上游版本号 |
| 2305 文件 (+394,468 / −63,276) | 上游改动面 |
| 74 / 308 | 双方都改过的文件数（冲突风险区）/ 只有本仓改过的文件数（可无损存活） |
| 57 = 46 + 11 | 直接 `git merge upstream/main` 的冲突文件数 = 内容冲突 + 修改/删除冲突 |
| 4 项 | 上游破坏性架构重构的数量，其中 3 项取代本仓自有实现 |

### 3.2 三条必须知道的判断

1. **规模差不是主要问题，方向重叠才是**。上游 260 个提交里 147 个是 `fix`，属常规演进；真正卡住同步的是 4 个架构动作——持久化、身份、配置、生成链路——它们删掉或替换了本仓正在依赖的文件。
2. **本仓 105 个私有提交的大头是安全的**。308 个只有本仓改过的文件里，`.qoder/` 治理与文档占 188 个、`scripts/` 工具占 47 个，真正与上游争夺接口的产品代码只有 41 个文件（见 `6.2`）。
3. **天真合并会留下哑弹**。上游删除了 `lib/server/classroom-generation.ts` 等模块，本仓有 8 个文件仍在 import 它们（见 `7.3`）；`git merge` 会把它们标成 modify/delete 并把本仓版本留在树里，编译期才炸。

## 4 差了多少：分叉已 59 天，两侧改动面差两个数量级

### 4.1 时间轴与提交量

分叉点 `019fe6e6`（2026-08-12，`feat(video-export): add explicit CPU resource profiles`）。上游当前 HEAD `7d324aa8`（2026-10-10，`fix(persistence): share one AsyncLocalStorage across owner-bound stores`）。跨度 59 天。

上游 260 个提交按类型分布：

| type | 条数 |
|---|---|
| fix | 147 |
| feat | 68 |
| test | 9 |
| release | 9 |
| docs | 9 |
| refactor | 6 |
| ci | 4 |
| perf | 2 |
| harden / chore / build | 各 1 |
| 无 conventional 前缀 | 3 |

上游改动量最高的 scope：export 17、generation 13、media 13、storage 9、pi 9、tts 7、render 7、importer 7、agent 7、providers 6。

本仓 105 个私有提交按 scope 分布的前端：scripts 17、repowiki 10、security 6、deploy 4、classroom 4——工具与治理占多数，产品改动集中在 classroom / tts / hooks 三处。

### 4.2 文件与代码行跨度

| 侧 | 文件数 | 增行 | 删行 | 其中新增文件 | 其中删除文件 |
|---|---|---|---|---|---|
| 上游 | 2305 | +394,468 | −63,276 | 1441 | 136 |
| 本仓 | 382 | +71,666 | −771 | — | — |

上游改动按目录聚类的头部：`packages/@openmaic` 259、`lib/server` 186、`tests/server` 129、`tests/agent-runtime` 89、`tests/workbench` 86、`app/api` 80、`components/workbench` 54、`lib/media` 50、`lib/workbench` 49、`components/edit` 48。

本仓改动按目录聚类的头部：`.qoder/repowiki` 177、`public/avatars` 13、`app/api` 13、`lib/server` 11、`lib/i18n` 8、`e2e/tests` 8、`packages/@openmaic` 7、`docs/security` 5。

### 4.3 版本号与工具链跨度

| 项 | 分叉点 / 本仓 | 上游 | 判断 |
|---|---|---|---|
| `package.json` version | 0.3.10 | 1.2.0-rc.1 | 跨 major 两次 |
| Node engines | `>=20.9.0` | `>=22.19.0` | 本机 v24.19.0 已满足，非阻塞 |
| pnpm | 10.28.0 | 10.28.0 | 无跨度 |
| next | 16.1.2 | 16.3.3 | 小版本 |
| react | 19.2.3 | 19.2.3 | 无跨度 |
| `@openmaic/storage` | 0.2.5 | 0.37.3 | 资产池抽象的全部演进都在这 |

上游标签序列已推进到 `v1.0.0` `v1.0.1` `v1.0.2` `v1.0.3` `v1.1.0` `v1.1.1` `v1.2.0-rc.1`；本仓 `docs/VERSIONING.md` 约定的「版本号跟随上游」自 `0.3.10` 起未再执行。

删除的集中点：上游 136 个被删文件中有 54 个落在单个发布提交 `636fab0d release: OpenMAIC 1.2.0-rc.1 (server-first)`（`#1794`），占四成；其余散在 `#1710` 等各次重构里。本仓要面对的不是一次孤立的破坏性提交，而是这一整批接口搬迁的叠加效果。

## 5 差在哪（上游侧）：能力增量集中在导出与媒体，底座换成了服务端优先

### 5.1 新增能力按功能域分布

| 域 | 本仓当前没有的能力 |
|---|---|
| 导出 | 整堂课后离线单文件 HTML、大课堂回退成 ZIP、PPTX 保留交互与测验占位页、旁白稿导出 Markdown/DOCX、导出前渲染队列预检 |
| 生成 | 服务端生成运行的宿主钩子（`#1807`）、按 fallback 模型重试一次、视频导出有界本地分块执行器 |
| 媒体与存储 | 资产池与服务端字节存储（`#1007` 系列，`packages/@openmaic/storage`）、派生资产带血缘与抽取缓存、素材库 manifest 与按 id 寻址的生成图 |
| 认证 | owner identity seam（`lib/server/identity/`）、单租户请求解析到共享 owner、owner claim 合并 |
| 配置 | `openmaic.yml` + 能力槽 + 服务端模型配置（RFC `#1701`，PR `#1765`） |
| 课堂交互 | Pi 教室内核成为默认（`#1628`）、Native Child 运行时与白板工具、静态 GenUI 组件引用、场景交互状态采样进提问 |
| 模型与 Provider | Google Gemini TTS、Qwen TTS 音色克隆、GLM CogView 图像、OpenRouter 图文、Exa 搜索、TokenDance 一键预设、Kimi coding plan、Grok 4.6、deepseek-v4-flash-vision-exp、Xiaomi MiMo V2.6 |
| i18n | 德语、越南语；浏览器原生 TTS 自动识别越南语 |

### 5.2 四项破坏性重构

1. **`feat(persistence)!` `fa47efe1`（`#1710`）服务端持久化唯一化**。删除分叉点上仍存在的 Dexie 封装 `lib/utils/database.ts`（已核实：base 存在、上游不存在）与 `lib/storage/*`；构建期开关 `NEXT_PUBLIC_PERSISTENCE` 在上游 `lib/` 代码中已无消费者，而本仓仍在 `lib/persistence/bootstrap.ts`、`lib/persistence/server-auth.ts`、`lib/whiteboard/runtime/legacy-import.ts`、`Dockerfile`、`docker-compose.yml` 读取它。`DATABASE_URL` 成为启动硬要求（`lib/server/database-requirement.ts`）。设备态迁到新库 `lib/device-storage/`；旧浏览器数据经 `lib/legacy-browser-import/` 单向一次性导入。
2. **`feat(auth)` `a686481e` owner identity seam**。新增 `lib/server/identity/`，把原先三处 owner 解析收敛成单一注册点 `configureOwnerAuthentication({ methods })`，宿主自定义身份应实现 `OwnerAuthMethod` 注册进去。`x-learner-key` 在上游 `lib/` 中已无读取点（读取仅剩测试与 CHANGELOG），改由 `GET /api/persistence/learner-key` 下发；上游另有 `tests/server/identity/cookie-guard.test.ts` 守 cookie 读取。
3. **`feat(config)` `5312c2b4`（`#1765`）配置权威移到服务端**。`lib/store/settings.ts` 从分叉点的 2100 行降到上游的 337 行（本仓该文件为 2139 行），provider/key/模型选择从客户端 store 中删除，客户端改由 `lib/model-settings/*` 读 `/api/model-config`；`lib/server/provider-config.ts` 增 484 行并获得能力槽 API。
4. **生成链路整体搬迁**。`lib/server/classroom-generation.ts`、`classroom-job-runner.ts`、`classroom-media-generation.ts`、`lib/hooks/use-scene-generator.ts`、`app/api/extract-document/route.ts`、`app/api/classroom/route.ts` 在上游被删除，逻辑进入 `lib/server/generation/*`、`lib/generation-run-client/*`、`app/api/generation-runs/*`、`app/api/materials*`（映射见 `5.3`）。`packages/@openmaic/generation` 成为新 workspace 包。

### 5.3 旧路径到新路径的映射

新路径均已用 `git cat-file -e upstream/main:<path>` 逐个确认存在。

| 本仓还在用的 | 上游新落点 |
|---|---|
| `lib/server/classroom-generation.ts` | `lib/server/generation/run/*` + `lib/server/generation/steps/*` |
| `lib/server/classroom-job-runner.ts` / `classroom-job-store.ts` | `lib/server/generate-classroom-job.ts`、`app/api/generation-runs/*`、客户端 `lib/generation-run-client/*` |
| `lib/server/classroom-media-generation.ts` | `lib/server/classroom-media-bytes.ts` + `lib/server/generation/run/media.ts` |
| `lib/hooks/use-scene-generator.ts` | `lib/generation-run-client/use-generation-run.ts` |
| `app/api/extract-document/route.ts` | `app/api/materials*` |
| `app/api/classroom/route.ts` | `lib/server/agent-runtime/course-generation.ts`，走 `app/api/agent/runtime` |
| `lib/utils/database.ts` | `lib/device-storage/*` + `lib/legacy-browser-import/*` |
| `lib/config/apply-token-plan.ts` | `lib/model-settings/token-plan.ts` |
| provider/key 客户端配置 | `lib/model-settings/*` + `lib/server/model-config/*` |
| `vercel.json` | 已删除 |

扩展点：上游提供 `lib/server/generation-run-hooks/`（`#1807`）作为宿主介入服务端生成的官方缝隙——本仓的批量生成/回填类改动以后应挂这里，而不是改生成引擎。

## 6 差在哪（本仓侧）：105 个私有提交里只有 41 个文件与上游争夺接口

### 6.1 私有能力清单

这些是本仓有、上游没有的产品能力，且上游没有等价物取代它们：

| 能力 | 载体 |
|---|---|
| TTS 预生成与缺失回填 | `app/api/classroom/[id]/regenerate-tts/route.ts`、`app/api/classroom/[id]/backfill-tts/route.ts`、`lib/audio/regenerate-all-speech.ts`、`lib/store/voice-regen.ts`、`scripts/backfill-missing-tts.mjs`、`scripts/verify-tts-completeness.mjs` |
| 导师音色切换 | `components/stage/mentor-voice-switcher.tsx`、`e2e/tests/mentor-voice-switching.spec.ts` |
| 连续学习 / Philochora 回调 | `app/api/philochora/chapter-complete/route.ts`、`lib/hooks/use-continuous-learning.ts`、`components/scene-renderers/next-lesson.tsx`、`e2e/tests/continuous-learning-callback.spec.ts` |
| 自有认证 | `lib/server/oauth-client.ts`、`oauth-config.ts`、`session-cookie.ts`、`app/api/auth/callback/route.ts` |
| 边缘路由与访问门禁 | `proxy.ts`（268 行；本仓删除了 `middleware.ts`）、`components/access-code-guard.tsx` |
| 托管部署隐藏设置入口 | `lib/config/feature-flags.ts` 的 `isSettingsEnabled` / `isQualityValidationEnabled`、`components/settings/index.tsx` |
| 密钥治理与告警 | `lib/server/key-audit.ts`、`lib/server/rate-limit.ts`、`lib/alerting/index.ts`、`lib/logger/redact.ts`、`scripts/check-secrets.mjs`、`scripts/rotate-keys.mjs`、`scripts/detect-key-abuse.mjs`、`.githooks/` |
| 公共静态资源与 base path | `app/api/public/[...path]/route.ts`、`lib/utils/base-path.ts`、`lib/fetch-base-path.ts` |
| 内容采集 | `scripts/zlibrary-search.mjs`、`zlibrary-download.mjs`、`import-books.py`、`batch-generate-chapters.mjs`、`run-translation.mjs` |
| 部署运维 | `scripts/deploy-sync.sh`、`deploy-nginx.sh`、`deploy-verify.mjs`、`deploy-health-check.mjs`、`service-ecosystem.config.cjs`、`deploy/nginx/philochora.conf` |

### 6.2 不与上游重叠的治理与工具面

308 个「只有本仓改过」的文件按目录分布：`.qoder/` 188（repowiki 与规则）、`scripts/` 47、`lib/` 15、`public/` 13、`e2e/` 9、`docs/` 6、`components/` 6、`app/` 6、`tests/` 4、`.githooks/` 2，加上 `proxy.ts`、`VERSION`、`CONTEXT.md`、`CLAUDE.md`、`tsconfig.json`、`render-service/`、两个 `ecosystem.*.config.cjs`、`deploy/` 等零散项。

即产品代码 41 个文件（lib 15 + app 6 + components 6 + e2e 9 + tests 4 + `proxy.ts` 1），其余 267 个是文档、规则与脚本——它们不与上游任何文件竞争，同步时可整体保留。

## 7 差在哪（两侧交集）：74 个文件双方都改，合并后留下 8 处死引用

### 7.1 74 个重叠文件的分布

双方都改动过的文件里，上游侧改动最重的（增/删行）：

| 文件 | 上游 ±行 | 本仓性质 |
|---|---|---|
| `lib/i18n/locales/*.json`（8 个语言） | 各 +727 / −197 | 本仓追加中文与课堂文案 |
| `app/page.tsx` | +626 / −506 | 首页表单改造 |
| `components/generation/generation-toolbar.tsx` | +497 / −851 | 生成工具条 + 内嵌 MediaPopover |
| `components/settings/index.tsx` | +448 / −55（另有 +157/−1059） | 托管部署隐藏设置入口 |
| `lib/store/settings.ts` | +211 / −1974 | 本仓加特性开关与 profile |
| `lib/server/provider-config.ts` | +414 / −70 | 本仓 provider 重构 |
| `lib/classroom/load-classroom.ts` | +335 / −151 | 本仓课堂加载与 401 处理 |
| `lib/hooks/use-discussion-tts.ts` | +298 / −73 | 本仓讨论音频修复 |
| `app/generation-preview/page.tsx` | +278 / −1231 | 本仓预览计时与重试 |
| `components/edit/PlaybackChromeRoot.tsx` | +448 / −25 | 播放外壳 |
| `.env.example` | +424 / −55 | 本仓部署与密钥变量 |

### 7.2 57 处合并冲突的构成

用 `git merge-tree --write-tree --name-only HEAD upstream/main` 干跑（不触碰工作区），退出码 1，得到 57 个冲突文件：

- **46 个内容冲突**，其中 8 个是 `lib/i18n/locales/*.json`（机械合并即可，实际代码冲突为 38 个）。其余 38 个覆盖 `app/page.tsx`、`app/classroom/[id]/page.tsx`、`app/generation-preview/page.tsx`、`app/api/generate-classroom/route.ts`、`app/api/health/route.ts`、`app/api/generate/image/route.ts`、`components/settings/index.tsx`、`components/stage/header-controls.tsx`、`components/chat/*`、`lib/store/settings.ts`、`lib/store/stage.ts`、`lib/server/provider-config.ts`、`lib/server/classroom-storage.ts`、`lib/playback/engine.ts`、`lib/orchestration/registry/store.ts`、`lib/utils/{audio-player,iframe}.ts`、以及配置面 `package.json` `next.config.ts` `playwright.config.ts` `docker-compose.yml` `.env.example` `.gitignore` `CHANGELOG.md`。
- **11 个修改/删除冲突**：本仓改过而上游删除的 `app/api/classroom/route.ts`、`app/api/extract-document/route.ts`、`components/generation/media-popover.tsx`、`lib/hooks/use-scene-generator.ts`、`lib/server/classroom-generation.ts`、`lib/server/classroom-job-runner.ts`、`lib/server/classroom-media-generation.ts`、`tests/hooks/use-scene-generator-retry.test.ts`、`tests/server/classroom-media-generation.test.ts`、`tests/store/settings-server-sync.test.ts`；以及反向一例——本仓删除、上游仍在改的 `middleware.ts`。

`git merge-tree` 同时显示 40 余个文件可自动合并（含 `lib/config/feature-flags.ts`、`components/roundtable/index.tsx`、`components/canvas/canvas-area.tsx`、`lib/audio/constants.ts`、`app/api/proxy-media/route.ts` 等），说明冲突面虽宽但不弥散。

### 7.3 本仓仍在 import 已被上游删除的模块

已逐个 grep 确认的 import 站点（合并后这些文件会指向不存在的路径）：

| 引用方 | 被引模块 |
|---|---|
| `app/api/generate-classroom/route.ts`（`GenerateClassroomInput`、`runClassroomGenerationJob`） | `classroom-generation`、`classroom-job-runner` |
| `lib/server/classroom-job-store.ts`（本仓独有） | `classroom-generation` |
| `app/api/classroom/[id]/regenerate-tts/route.ts`（`generateTTSForClassroom`，本仓独有） | `classroom-media-generation` |
| `app/api/classroom/[id]/backfill-tts/route.ts`（`backfillMissingTTSForClassroom`，本仓独有） | `classroom-media-generation` |
| `app/classroom/[id]/page.tsx`（`useSceneGenerator`） | `use-scene-generator` |
| `app/generation-preview/page.tsx`（多个导出） | `use-scene-generator` |
| `lib/audio/regenerate-speech-tts.ts`（`generateAndStoreTTS`） | `use-scene-generator` |
| `components/generation/generation-toolbar.tsx`（`MediaPopover`） | `media-popover` |

另有 URL 级引用 `/api/classroom`（上游该路由已删）散落在 `lib/classroom/load-classroom.ts`、`proxy.ts`、`scripts/deploy-health-check.mjs`、`e2e/tests/continuous-learning-callback.spec.ts`。

### 7.4 三组正面撕裂：认证、边缘路由、配置权威

| 本仓自有 | 上游替代物 | 撕裂性质 |
|---|---|---|
| `lib/server/oauth-client.ts` + `oauth-config.ts` + `session-cookie.ts` + `app/api/auth/callback/`，且 `lib/persistence/bootstrap.ts`、`server-auth.ts` 仍读 `x-learner-key` | `lib/server/identity/` 的 `OwnerAuthMethod` 注册点，learner-key 改由服务端下发 | 本仓是并行的第二套 cookie 层，不是注册进 seam 的插件；上游另有 cookie 守卫测试 |
| 删除 `middleware.ts`、自建 `proxy.ts`（268 行边缘路由） | 上游 `middleware.ts` 仍在演进（77 行） | `merge-tree` 已判为修改/删除冲突，两侧语义需人工合流 |
| `lib/config/feature-flags.ts` + `lib/store/settings.ts` 的「托管部署隐藏设置入口」与客户端 provider 配置 | `openmaic.yml` 服务端能力槽 + `lib/model-settings/*` | 客户端开关与服务端配置两套权威并存，本仓 2139 行 store 与上游 337 行 store 无法机械合并 |

## 8 要不要补：三条路线的成本、收益与风险（本轮不执行）

本节仅评估，不构成动作。本轮交付物到 `7` 为止。

| 路线 | 做法 | 收益 | 成本与风险 |
|---|---|---|---|
| A 新基线重植 | 从 `upstream/main` 开干净分支，把 `6.1` 的私有能力按上游新接口逐个移植（认证走 `OwnerAuthMethod`、生成走 `generation-run-hooks`、配置走 `lib/model-settings`） | 得到上游全部 147 个 fix 与新能力；此后每次同步不再重解同一批冲突；消除 `7.3` 的死引用 | 需重写 `7.4` 三组撕裂的实现位置，41 个产品文件逐个判断去留；一次性投入最大，但避免了「解冲突时把上游 337 行 store 改回 2139 行」这类反向重写 |
| B 原分支直接 merge | 在 `custom-main` 上 `git merge upstream/main`，逐个解 57 处冲突 | 保留 git 追溯，做法与本仓历史 4 次合并一致 | 修改/删除冲突会把已被上游废弃的模块留在树里；`lib/store/settings.ts`、`app/generation-preview/page.tsx` 两侧行数差悬殊，解完仍是一致性债务；死引用要到编译或运行才暴露 |
| C 按域切片多次合并 | 先合低耦合域（i18n 8 个 locale、公开静态资源、skills）→ 再合媒体/存储/导出 → 最后合持久化/身份/配置 | 每片独立验证、独立回滚，风险可控 | 总周期最长；中间态长期存在两套 provider 配置权威，切片期间任何新功能都要选边 |

选择依据（供后续决策，不是本轮结论）：若本仓短期内还要继续迭代课堂与语音能力，A 或 C 更划算——`7.4` 的三组撕裂不会随时间自愈；若只求不再落后，B 是最快回到「已同步」外观的做法，但会把死引用与双权威留在树里。

## 9 参考 / 引用

### 9.1 复现命令

本文每个数字都可用下列命令独立复现，均在仓库根目录执行，且全部为只读命令。

| 断言 | 命令 |
|---|---|
| 分叉点 `019fe6e6` | `git merge-base HEAD upstream/main` |
| 上游 260 / 本仓 105 提交 | `git rev-list --count 019fe6e6..upstream/main`；`git rev-list --count 019fe6e6..HEAD` |
| 提交 type 分布 | `git log --format='%s' 019fe6e6..upstream/main \| grep -oE '^[a-z]+' \| sort \| uniq -c \| sort -rn` |
| 两侧改动面与增删行 | `git diff --shortstat 019fe6e6..upstream/main`；`git diff --shortstat 019fe6e6..HEAD` |
| 上游新增/删除文件数 | `git diff --diff-filter=A --name-only 019fe6e6..upstream/main \| wc -l`；同理 `--diff-filter=D` |
| 删除集中于 `636fab0d` 的 54 个 | `git diff --diff-filter=D --name-only 636fab0d^..636fab0d \| wc -l` |
| 74 个重叠文件 | 两侧 `git diff --name-only ... \| sort` 后 `comm -12` |
| 308 个本仓独有文件 | 同上改用 `comm -23`；按目录计数再 `awk -F/ '{print $1}' \| sort \| uniq -c` |
| 57 处冲突及其构成 | `git merge-tree --write-tree --name-only HEAD upstream/main`（exit 1）；`grep -c 'CONFLICT (content)'`；`grep -c 'CONFLICT (modify/delete)'` |
| 版本号跨度 | `grep '"version"' package.json`；`git show upstream/main:package.json \| grep '"version"'` |
| Node engines / next / react / storage 版本跨度 | `git show <rev>:package.json`、`git show <rev>:packages/@openmaic/storage/package.json` |
| `lib/store/settings.ts` 三侧行数 | `git show <rev>:lib/store/settings.ts \| wc -l`，rev 取 `019fe6e6`、`HEAD`、`upstream/main` |
| 上游新路径存在性 | `git cat-file -e upstream/main:<path>` |
| 死 import 站点 | `git grep -n "from ['\"].*<模块名>" HEAD -- app lib components tests` |
| 本仓历史合并方式 | `git log --merges --oneline HEAD` |

关键上游提交（均可 `git log -1 --format='%h %s' <sha>` 核验）：`fa47efe1`（`#1710` 持久化）、`a686481e`（identity seam）、`5312c2b4`（`#1765` / RFC `#1701` 配置）、`636fab0d`（`#1794` 1.2.0-rc.1 server-first 发布）、`2a77a8a4`（`#1628` Pi 默认）、`a3c17b61`（`#1807` 生成宿主钩子）。

### 9.2 数据口径与取证日期

- 全部数字取证于 **2026-10-11**，基线为 `upstream/main` = `7d324aa8`（本轮 `git fetch upstream` 后取得）、`custom-main` = `482c17a0`。上游与本仓任一侧前进后，本文表格即过期，须按 `9.1` 重跑。
- 冲突数取自 `git merge-tree` 的三方合并模拟，**不等于**实际合并时的手工解决次数（自动合并成功但语义错误的文件不计入）。
- 「产品代码 41 个文件」按目录前缀统计 `lib/ app/ components/ e2e/ tests/` 与根级 `proxy.ts`，不含 `.qoder/` `docs/` `scripts/` `public/` `.githooks/`。
- 上游 PR 号一律以 `git log` 主题中可 grep 到的 `#NNNN` 为准；无 conventional 前缀的 3 条提交主题为 `#1855` `#1127` `#1148`。
- 本文不引用也不复用 `.qoder/upstream-merge-report.canvas.tsx` 的任何数字：该报告描述的是 23 个提交、目标分支 `merge-upstream-persistence`（`8a1459a`）的一次历史合并结果，基线远早于本文，不可当作现状阅读。

### 9.3 未验证项

| 项 | 状态 |
|---|---|
| 上游 `feat(api)!`（`#1728`）把 `POST /api/generate-classroom` 请求体收窄为 `{ requirement, materialIds? }` | **未验证**——本文未据此下任何结论，仅作线索记录 |
| 上游 settings store 的 persist 版本号与旧客户端配置的迁移脚本行为 | **未验证** |
| `#1007` 资产池各分片的落地顺序与依赖 | 未逐条核对，仅确认 `packages/@openmaic/storage` 的字节存储抽象存在且版本从 0.2.5 跃至 0.37.3 |
| 上游 `fix` 提交中哪些确切覆盖了本仓的对应补丁 | **未验证**——`8` 未给结论；真要同步时必须逐个比对 diff，不能凭 scope 与标题相似就判定可丢弃 |

## 10 合并执行记录（2026-10-22）

本节记录 `custom-main` 实际同步上游 `v1.2.1` 的执行结果，不替代前述差异分析与路线评估。

### 10.1 基线与冲突

| 项 | 值 |
|---|---|
| 上游基线 | `upstream/main` = `e19ed13f`（v1.2.1，2026-10-22 fetch） |
| 本仓基线 | `custom-main` = `a3c96d53` |
| 提交差 | 落后 314 个提交，领先 106 个私有提交 |
| 干跑冲突 | 60 个文件 = 49 个内容冲突 + 11 个修改/删除冲突 |
| 合并落点 | 独立分支 `merge/upstream-1.2.1`，worktree `.worktrees/upstream-1.2.1` |

### 10.2 解决原则

1. **生成主链路保留本仓实现**：`app/page.tsx` → `app/generation-preview/page.tsx` → `app/classroom/[id]/page.tsx` 三页与 `classroom-generation` / `classroom-job-runner` / `classroom-media-generation` / `use-scene-generator` / `media-popover` 继续作为默认链路；上游新的 `/api/generation-runs`、`/workbench`、`ClassroomSurface` 并列保留，不接入本仓默认入口。
2. **边缘路由保留 `proxy.ts`**：`middleware.ts` 保持删除；上游针对 middleware 的测试改为直接测试 `@/proxy`。
3. **本地能力全部保留**：TTS 预生成/回填、导师音色切换、连续学习、Philochora 回调、自有 OAuth、访问码、隐藏设置入口、密钥审计、多 key 轮询、basePath 静态资源、部署脚本。
4. **服务端配置采用上游**：`lib/server/provider-config.ts` 以上游 v1.2.1 为基线，回放本仓多 key 轮询、密钥访问审计与 `isServerLLMConfigured`。
5. **设置 store 保留本仓客户端配置**：继续以本仓 2139 行 store 管理 provider/key/model；补上游 `getValidASRLanguage`、`ttsVoiceProviderId` 与 `legacyModelSettings` 兼容字段。
6. **AudioPlayer 双兼容**：保留上游共享 audio element、legacy URL 拉取与 abort，同时保留本仓 `{voice}` 模板、当前音色→默认音色→IndexedDB 的回退链。

### 10.3 兼容层与拆分

| 变更 | 目的 |
|---|---|
| 恢复 `classroom-generation`、`classroom-job-runner`、`classroom-job-store`、`classroom-media-generation`、`use-scene-generator`、`scene-generation`、`regen-lock`、`utils/database`、`utils/model-config`、`settings-validation`、`image-storage`、`use-draft-cache`、`pbl-fallback-hydration` 等本仓模块 | 上游删除但本仓生成链路仍依赖 |
| `lib/media/client-media-generation.ts` | 本仓客户端媒体生成与上游 `retryMediaTask` 分文件并存，`media-orchestrator` 只再导出前者 |
| `lib/utils/normalize-media-urls.ts` | 从 `load-classroom` 拆出，避免 stage store 因导入该工具而拉起整条加载链路 |
| stage store 兼容 actions | 补 `generationEpoch`、`setGeneratingOutlines`、`setGenerationStatus`、`addFailedOutline`、`markGenerationCompleteIfDone` 等旧链路 API |
| asset-pool 兼容 | 新存储无 in-place replace，`replaceAsset` 以 remove + put 模拟；`removeAsset` 直连池 |
| `model-routes` 兼容 | 新增 `generate-classroom` stage 映射到 `classroom` slot；`getStageModel` 返回 `undefined`（上游已移除 `MODEL_ROUTES`） |
| 恢复 `app/api/generate/{scene-outlines-stream,scene-content,scene-actions,agent-profiles}` 与 `app/api/web-search` | 本仓客户端生成链路实际调用的路由，上游在 server-first 重构中删除；缺失时预览页 404 |
| `resolveModelFromRequestOrDeployment` | 客户端模型未被部署授权时，回退到 `resolveModel({ stage })` 的部署模型，避免旧链路被 403 |
| `llmApiError` 与流式 `onError` 诊断 | 兼容旧路由的错误响应；输出上限从 `outputWindow` 钳到 16384，避免把上下文窗口当 max_tokens |
| `ModelSettingsInit` 启动同步 `fetchServerProviders()` | 让本仓客户端 settings store 拿到服务端托管 provider；缺失时首页一直显示「配置模型」 |

### 10.4 验证

| 检查 | 结果 |
|---|---|
| `pnpm exec tsc -p tsconfig.json --noEmit` | 0 errors |
| `pnpm exec tsc -p tsconfig.build.json --noEmit` | 0 errors |
| `pnpm build` | 通过（Next.js 16.3.3，生成 `BUILD_ID`） |
| `vitest run tests/audio tests/classroom tests/store tests/hooks --no-file-parallelism` | 84 个文件 / 873 项通过 |
| `gitnexus detect_changes scope=all` | `risk_level: critical`，6825 symbols / 2553 files / 678 processes（整仓同步的预期结果） |
| 运行时 smoke（3002 端口，独立 `openmaic_smoke` 库） | `/api/health` 200（`version=1.2.1`、`llmConfigured=true`）；首页与设置对话框正常，服务端托管 provider 可见 |
| 生成链路 smoke（服务端授权 Qwen3.7 Plus） | `scene-outlines-stream` 200、`agent-profiles` 200、`scene-content` 200（单场景约 6 分钟），页面进入场景动作阶段 |
| 环境说明 | 本机 `.env.local` 的 DeepSeek key 调 `api.deepseek.com` 返回 401；切换服务端已授权的 Qwen 后跑通，属环境凭据问题，不是合并回归 |

### 10.5 遗留风险

1. **双生成管线并存**：本仓默认入口走客户端旧链路，上游新链路（generation-runs、workbench、ClassroomSurface、server-first 持久化）已入库但未接入默认 UI；后续若切换入口需单独迁移 TTS/质量校验等挂载点。
2. **设置权威双轨**：客户端 settings store 与服务端 `/api/model-config` 同时存在；上游新的模型服务 UI 与本仓 provider 配置 UI 的边界需在后续迭代收敛。
3. **`replaceAsset` 语义变化**：服务端资产池不支持原地替换，现以 remove + put 模拟；旧客户端 TTS 再生成若依赖稳定 id，需在运行时验证。
4. **浏览器冒烟只覆盖到内容生成**：已在 3002 端口用独立 smoke 库完成首页 → 设置 → 大纲 → 角色 → 场景内容（200）→ 场景动作的链路；DeepSeek key 在本机 `.env.local` 返回 401，切换到服务端已授权的 Qwen 后跑通，Qwen 单场景约 6 分钟。课堂播放、TTS 音色切换、连续学习回调仍未端到端验证，完整 E2E 未跑。
5. **移除了 3 个上游测试**：`course-materials.test.ts`、`owner-generation-gate.test.ts`、`settings-model-settings-migration.test.ts` 分别断言本仓未采用的工具栏、课堂页与 v5 设置迁移；保留会造成与既定架构冲突，后续如需采用对应上游能力应连同测试恢复。
6. **旧课堂迁移缺口（2026-10-22 补记）**：存量课堂可直接打开和播放，但未绑定 `stage_meta`、DSL 版本停留在 0.1.0、且 `document_stages` 上遗留冲突触发器，导致首页列表为空、自动保存失败。内容本身不需要重生成，缺的是一次性存储迁移；验证与修复路径见第 11 节。

## 11 旧课堂验证与残留任务清理（2026-10-22）

本节记录合并后对存量课堂的全量静态校验、运行态抽查，以及残留生成任务清理。验证在独立库 `openmaic_verify_20261022` 中进行（结束后已删除）；生产库 `philochora` 未做任何写入。

### 11.1 存量课堂全量校验

| 检查 | 结果 |
|---|---|
| 课堂 JSON / scene | 193 个 / 1759 个，JSON 解析 0 错误 |
| 应用写边界校验器（`validateAppStage` / `validateAppScene`） | 0 错误 |
| DB 文档库对齐 | 193 个 stage，ID 与文件名完全一致；逐课堂 scene 数全部一致；无空 stage |
| 非音频媒体引用 | 29 条，文件全部存在 |
| TTS 完整性 | 191/193 完整；`kzqaQB5_u_`（Test Connectivity，缺 76）与 `DsZSyUNTdN`（DeepSeek Key Precheck，缺 66）为测试产物，按口径只报告 |

### 11.2 运行态验证

- 独立验证服务：3002 端口、`openmaic_verify_20261022`、basePath `/openmaic`、单用户模式。
- HTTP：逐个 GET `/api/classroom?id=`，193/193 返回 200，`stage.id` 与 scene 数全部匹配；未知 id 返回 404。
- 浏览器抽查 3 个代表课堂，3/3 正常渲染并播放：

| 课堂 | scene 数 | 场景类型 | 结果 |
|---|---|---|---|
| `jKWTUciIe7` 东西方哲学经典思想入门 | 13 | slide + quiz | 播放、音频 200/206、聊天 runtime 201 |
| `HF4OvPvIqW` 东西方哲学入门 | 19 | slide + quiz + interactive | 播放、音频 200/206 |
| `WfArEVoQyW` 科学解释模型：DN与因果 | 8 | slide + interactive + quiz | 第 4 场景互动 iframe 渲染（87 KB srcdoc），音频 200 |

### 11.3 发现的迁移缺口

旧课堂内容本身不需要重生成，但当前生产库缺一次存储迁移，导致三类症状：

1. **首页课程列表为空**：`document_stages` 有 193 条，`stage_meta` 的 owner 绑定为 0 条；`/api/stages` 按 owner 过滤后返回空数组。
2. **自动保存 404**：旧课堂由文件回退加载，文档库没有对应 owner 文档；`PUT /documents/<id>/stage` 报 `document not found`。
3. **DSL 版本过期**：`scripts/sync-classrooms-to-pg.mjs` 把文档写成 `dslVersion 0.1.0`，当前 `DSL_VERSION=0.3.0`；部分保存被 400 拒绝。
4. **冲突触发器**：共享库遗留 `trg_document_stages_updated_at` 调用 `set_updated_at()`，把 timestamptz 写入 double precision 的 `updated_at`；全量保存报 `22P02`。`@openmaic/storage` 自身不创建该触发器。

已在隔离库用 `jKWTUciIe7` 验证修复路径：补 `stage_meta(owner_id='local')` → 删除 `trg_document_stages_updated_at` → 全量 PUT 一次把 DSL 升到 0.3.0。结果为：首页「最近学习 193」、课堂 GET 200、`PUT /stage` 204、无 console error。生产库执行时需先按实际身份模式确定 owner id（`OWNER_SINGLE_USER_ID`，默认 `local`，或 `PERSISTENCE_SHARED_OWNER_ID`），再逐课堂全量保存一次。

### 11.4 残留生成任务清理

- `data/classroom-jobs` 的 197 个 JSON 全部归档到 `data/classroom-jobs.archive-2026-10-22`：19 running / 42 failed / 136 succeeded，时间均为 2026-07-31，且没有任何一个对应现存课堂 JSON 或数据库 stage。
- 新建的 `data/classroom-jobs` 为空；`data/` 已 gitignore，未产生 git 变更。
- 两个 TTS 不完整的测试课堂保留原状。

### 11.5 验证工具

新增 `scripts/verify-classrooms.mts` 与 `pnpm verify:classrooms`，覆盖结构、应用校验器、媒体文件、TTS、DB 对齐、`stage_meta` owner 覆盖、DSL 版本和冲突触发器。默认内容错误失败，迁移告警不阻断；`--strict` 可把告警升级为失败。生产库当前运行结果为 `PASS (389 warnings)`：2 个 TTS 不完整 + 193 个缺少 owner 绑定 + 193 个 DSL 0.1.0 + 1 个冲突触发器。

### 11.6 未覆盖与遗留风险

- 浏览器只抽查 3 个代表课堂；193 个课堂的逐页播放未跑。
- 存量无 PBL 课堂，PBL 播放路径未覆盖。
- 生产库尚未执行 owner 绑定、触发器清理和 DSL 全量升级；旧课堂当前仍是「可直接播放、首页不显示、编辑不落库」状态。完成迁移后应重跑 `pnpm verify:classrooms --strict`，目标 0 warnings。

## 12 修订历史

| 版本 | 日期 | 改动 |
|------|------|------|
| v1.0.0 | 2026-10-11 | 首版。基于 `upstream/main` = `7d324aa8` 与 `custom-main` = `482c17a0` 的差异对比，记录分叉规模、上游四项破坏性重构与旧→新路径映射、本仓私有能力与 308 个可整体存活文件、`merge-tree` 干跑得知的 57 处冲突构成、8 处死 import、三组正面撕裂，以及三条同步路线的成本评估（本轮不执行）。所有数字附复现命令与取证日期，4 条断言显式标为未验证 |
| v1.1.0 | 2026-10-22 | 追加第 10 节合并执行记录：上游基线推进到 `e19ed13f`（v1.2.1），314 提交/60 冲突，记录独立集成分支、六条解决原则、兼容层拆分、tsc/build/873 项单测结果与五条遗留风险 |
| v1.1.1 | 2026-10-22 | 浏览器冒烟发现并修复三类真实回归：本地生成 API 路由缺失（404）、`llmApiError` 兼容缺失（500）、服务端 provider 未同步到客户端 store（首页卡「配置模型」）；补模型授权回退与 `maxOutputTokens` 钳制，冒烟跑到场景内容 200 |
| v1.2.0 | 2026-10-22 | 追加第 11 节旧课堂验证与残留任务清理：193 个课堂/1759 scene 全量静态与 HTTP 校验通过，3 个代表课堂浏览器播放通过；记录 owner 绑定缺失、DSL 0.1.0、冲突触发器三类迁移缺口及隔离库验证过的修复路径；归档 197 个残留生成任务；新增 `scripts/verify-classrooms.mts` 与 `pnpm verify:classrooms` |

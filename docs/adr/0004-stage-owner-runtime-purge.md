# ADR-0004: 已删除课程的 owner 可清理其运行数据

- **状态**：已采纳
- **日期**：2026-10-24
- **关联**：`app/api/persistence/[...path]/route.ts`、`lib/utils/stage-storage.ts`、`lib/persistence/owner-bound-document-store.ts`、`lib/persistence/runtime-tombstone-guard.ts`、ADR-0003、`docs/local-standalone.md`

## 背景

删除课堂由两段组成：

1. **文档侧是墓碑软删**：`owner-bound-document-store.deleteDocument` 只写 `stage_meta.deleted_at`、结束生成任务、解除文件夹关联并释放素材引用；`document_stages` 行保留。原因是 `stage_meta -> document_stages` 是 `ON DELETE CASCADE`，删行会连带删墓碑，课程 id 可被重新占用。
2. **运行数据侧应级联删除**：客户端在文档墓碑后调用 `HttpRuntimeStore.deleteStageRuntime`，即 `DELETE /api/persistence/runtime/stages/<id>`，删除该课程全部 learner 的 `runtime_sessions`（`runtime_records` 随外键级联）。

但运行数据这一半从未生效：

- 存储包把 stage 级运行数据删除放在 admin 门禁后（`packages/@openmaic/storage/src/server/index.ts`），而本应用把 `authorizeAdmin` 写死为 `false`，也没有任何 admin 身份；
- 客户端 5 秒超时后只 `console.warn` 并继续，界面表现为“删除成功”；
- 数据库没有任何运行数据清理任务。

结果是每次删除有运行数据（播放/答题/聊天/PBL）的课堂，都会留下不可达的孤儿行。墓碑守卫让这些行读不到，问题因此长期不可见。

## 决策

1. **路由层授权（根因修复）**：仅对 `DELETE /api/persistence/runtime/stages/<id>` 放行，且同时满足：
   - `stage_meta` 存在；
   - `stage_meta.owner_id` 等于请求解出的 owner id；
   - `stage_meta.deleted_at` 非空（课程已被墓碑）。
2. **全局清空继续拒绝**：`DELETE /api/persistence/runtime` 仍返回 `403 FORBIDDEN_ADMIN`。
3. **客户端级联前移**：文档墓碑成功后立即发起并等待运行数据删除，再执行本地缓存/游标/quiz 清理。本地清理失败仍按既有契约以部分级联错误上报，但不再可能跳过权威的运行数据删除。
4. **不新增自动清理任务**（2026-10-24 决定）：修复前已产生的孤儿行与未来超时/失败残留由运维手工清理，SQL 见下文。

## 被否方案

- **引入 service key / admin 身份**：只为一次删除级联新增一套凭据与信任链，扩大攻击面；且本应用的请求主体只有 owner。
- **给存储包的 `authorizeAdmin` 增加 stageId 参数**：需要改动上游包签名，给后续合并制造冲突；应用的每请求闭包已能完成同样判定。
- **客户端改走 learner 级删除**（`DELETE /runtime/stages/<id>/learners/<key>`）：服务端本就放行，但托管多用户场景下其他 learner 的运行数据仍会残留，不是完整修复。
- **任意状态放行**：课程 owner 在未删除课程上也能清空 learner 数据，超出删除级联需要；最小权限要求绑定墓碑。
- **周期清理任务 / 启动时清理**：用户明确选择不做自动清理，避免新增后台任务与多实例语义；历史数据由运维一次性处理。

## 后果

- **语义**：已墓碑课程的 owner 可以清空该课程**所有 learner** 的运行数据。课程已退役、数据经墓碑守卫不可达，清理不改变可见状态。
- **历史孤儿不会自动消失**。运维可执行：
  ```sql
  DELETE FROM runtime_sessions s
  USING stage_meta m
  WHERE s.stage_id = m.stage_id AND m.deleted_at IS NOT NULL;
  ```
  `runtime_records` 随 `runtime_sessions.id` 外键级联删除；重复执行幂等。
- **无 `stage_meta` 的课程仍为 403**：没有归属记录就没有放行依据；这类课程（如从未写入服务端的旧课堂）在服务端的运行数据无法按 stage 清理。
- **托管行为**：OAuth 模式下课程 owner 同样只影响自己的已删课程；admin 全局清空入口仍不存在。
- **测试**：`tests/persistence/runtime-stage-delete.test.ts` 覆盖放行、未墓碑拒绝、跨 owner 拒绝、未知 stage、全局清空、幂等、非法编码；`tests/utils/stage-storage-deletion.test.ts` 覆盖本地缓存失败时级联仍先发起。
- **未改动**：墓碑软删设计、存储包契约、`DELETE /runtime` 的 admin 语义。

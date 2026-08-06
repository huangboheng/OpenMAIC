import {
	Callout,
	Code,
	H1,
	MetricsGrid,
	ReportSection,
	ReportShell,
	Stack,
	Table,
	Text,
	Timeline,
} from "qoder/canvas";

export default function PostmanPhilochoraApiTestReport() {
	return (
		<ReportShell>
			<H1>Philochora API 冒烟测试报告（Postman）</H1>
			<Text tone="secondary">
				2026-08-06 · Postman MCP + Collection「Philochora API 冒烟测试」+ newman 6.2.2 本地运行 · 目标 localhost:3000
			</Text>

			<ReportSection title="成果摘要">
				<MetricsGrid
					variant="header"
					items={[
						{ label: "请求通过", value: "17/17", detail: "修复前 16/17，1 个 500", tone: "success" },
						{ label: "发现 Bug", value: "1 个", detail: "is_published 布尔列整数比较（42883）" },
						{ label: "修复提交", value: "5ec9ab0", detail: "fix(rag)，7 处 = 1 → = true" },
						{ label: "总耗时", value: "6.3s", detail: "平均响应 286ms（max 3.2s）" },
					]}
				/>
				<Callout tone="success" title="结论">
					全量公开只读端点冒烟测试通过。测试过程中发现并修复了 RAG 检索链路 7 处 PostgreSQL 42883
					查询错误（boolean 列与整数比较），修复后 rag.search 从 500 恢复为 200，正确返回典籍语义检索结果。
				</Callout>
			</ReportSection>

			<ReportSection title="测试矩阵">
				<Table
					headers={["模块", "端点", "结果", "说明"]}
					rows={[
						["系统健康", "ping", "200", "无参连通性检查"],
						["系统健康", "health.status", "200", "服务状态"],
						["系统健康", "openmaic.health", "200", "ok:false 属预期（引擎未启动）"],
						["典籍", "classics.books.list", "200", "分页列表（论语等 4083 条）"],
						["典籍", "classics.books.getBySlug", "200", "slug=lunyu 详情"],
						["典籍", "classics.books.search", "200", "全文搜索「道德」（3.2s）"],
						["典籍", "classics.categories.list", "200", "分类统计（佛家 1118 / 道家…）"],
						["书库", "books.list", "200", "分页列表（道德经等）"],
						["书库", "books.categories", "200", "空数组（无分类数据）"],
						["视频", "videos.list", "200", "耶鲁哲学课等 5 条"],
						["视频", "videos.categories", "200", "东西方哲学传统分组"],
						["每日哲学", "getToday / getHistory / getDailyQuestion", "200", "getToday json:null 属预期"],
						["RAG", "rag.search", "200 → 修复前 500", "「孔子思想」topK=3，相似度 0.99/0.98/0.98"],
						["OIDC", "openid-configuration / jwks.json", "200", "OIDC Discovery + JWKS（REST GET）"],
					]}
				/>
			</ReportSection>

			<ReportSection title="发现并修复的 Bug">
				<Callout tone="danger" title="根因：boolean 列与整数比较">
					PostgreSQL 中 <Code>boolean = integer</Code> 无匹配操作符（错误码 42883）。classics_books.is_published
					为 boolean 列，而 RAG 向量检索 / BM25 检索 / 摘要列表 / embedding 生成脚本共 7 处写成
					<Code>is_published = 1</Code>，导致 RAG 相关查询全部失败（生产环境同样受影响）。已全部改为
					<Code>= true</Code> 并提交 5ec9ab0。
				</Callout>
				<Table
					headers={["文件", "修复处数"]}
					rows={[
						["api/lib/rag.ts（vectorSearch + BM25 zh/en）", "3"],
						["api/queries/rag.ts（摘要列表 + 计数）", "2"],
						["api/scripts/generate-embeddings.ts（段落统计 + 分批）", "2"],
					]}
				/>
			</ReportSection>

			<ReportSection title="关键步骤">
				<Timeline
					events={[
						{
							id: "env",
							timestamp: "18:40",
							title: "环境准备与端点提取",
							description:
								"启动 philochora（PM2，localhost:3000）；从 api/router.ts 与各 -router.ts 提取公开 tRPC procedure 与 REST 端点，冒烟验证参数协议（GET query / POST mutation / httpLink 非 batch）。",
							tone: "info",
						},
						{
							id: "collection",
							timestamp: "18:44",
							title: "创建 Postman 工作区与 Collection",
							description:
								"Postman MCP 认证成功（huangboheng）；新建工作区 Philochora API Testing + Collection「Philochora API 冒烟测试」：7 文件夹 / 17 请求，全部携带浏览器 UA 头。",
							tone: "info",
						},
						{
							id: "run1",
							timestamp: "18:49",
							title: "首轮 newman 运行：16/17",
							description:
								"newman 6.2.2 本地执行（Postman 官方运行时；MCP 无 runCollection 且云端无法访问 localhost）。发现 rag.search 返回 500 INTERNAL_SERVER_ERROR。",
							tone: "warning",
						},
						{
							id: "root-cause",
							timestamp: "19:00",
							title: "定位根因：42883 操作符不存在",
							description:
								"逐层调试：Ollama embedding 正常（768 维 / 68ms）→ pg 直连复现 → 42883 无匹配操作符 → 定位到 is_published boolean = 1；EXPLAIN 确认 = true 后走 idx_classics_published_id 索引条件。",
							tone: "warning",
						},
						{
							id: "fix",
							timestamp: "19:05",
							title: "修复并提交",
							description:
								"3 文件 7 处 is_published = 1 → = true；rag.search 恢复 200（返回道枢/居士傳/儀禮要義，相似度 0.99/0.98）；提交 5ec9ab0，pre-commit 钩子 tsc/oxlint/biome/depcruise 全过。",
							tone: "success",
						},
						{
							id: "rerun",
							timestamp: "19:10",
							title: "复测全绿：17/17",
							description:
								"重启服务后重跑完整 Collection，全部 200 OK，0 失败；rag.search 响应 1.1s（无向量索引全表扫描，HNSW 索引后台构建中）。",
							tone: "success",
						},
					]}
				/>
			</ReportSection>

			<ReportSection title="测试要点沉淀">
				<Table
					headers={["要点", "说明"]}
					rows={[
						["反爬虫 UA 黑名单", "含 postmanruntime，Collection 每个请求必须显式携带浏览器 User-Agent，否则 403"],
						["tRPC 协议", "前端 httpLink（非 batch）：query 用 GET + input 参数（encodeURIComponent({json:…})），mutation 用 POST；加 batch=1 会导致 input 解析为 undefined"],
						["依赖服务", "RAG 依赖本地 Ollama（11434，已启动，含 bge-m3 / nomic-embed-text）；Redis（6379）未运行但内存回退正常"],
						["本地库漂移", "迁移 027 的 HNSW 向量索引未应用本地库（58 万行全表扫描约 1-4s），已在后台补建"],
					]}
				/>
			</ReportSection>

			<ReportSection title="遗留与提醒">
				<Callout tone="warning" title="本地 HNSW 索引后台构建中">
					idx_classics_paragraph_embeddings_hnsw（m=16, ef_construction=64）正在本地库后台构建，
					完成后 RAG 查询将显著提速；生产库需确认已应用迁移 027。
				</Callout>
				<Stack gap={6}>
					<Text tone="secondary" size="small">
						· Redis 未运行：RAG embedding 缓存与限流走内存回退，功能不受影响，恢复 Redis 后自动启用
					</Text>
					<Text tone="secondary" size="small">
						· Collection 已保存在 Postman 工作区「Philochora API Testing」，改 baseUrl 变量即可切换环境
					</Text>
				</Stack>
			</ReportSection>

			<Text tone="secondary" size="small">生成于 Philochora API 冒烟测试任务 · commit 5ec9ab0</Text>
		</ReportShell>
	);
}

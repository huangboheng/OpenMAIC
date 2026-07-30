import {
  Divider,
  Grid,
  H1,
  H2,
  H3,
  Stack,
  Stat,
  Table,
  Text,
  Callout,
  Card,
  CardHeader,
  CardBody,
  Tag,
  CollapsibleSection,
} from "qoder/canvas";

export default function ClassroomRootCauseFix() {
  return (
    <Stack gap={24}>
      <H1>Classroom c4CoWD85kW "no loadable data" 根因修复报告</H1>

      <Grid columns={4} gap={16}>
        <Stat label="根因归属" value="OpenMAIC" tone="warning" />
        <Stat label="修复文件" value="2" />
        <Stat label="已验证项" value="8" />
        <Stat label="TS 编译" value="零错误" tone="success" />
      </Grid>

      <Divider />

      <H2>根因分析</H2>

      <Callout tone="warning" title="核心根因">
        <Text>
          fetchClassroomFromApi 使用硬编码 /api/classroom URL，在
          basePath=&quot;/openmaic&quot; 环境下依赖全局 fetch 拦截器
          (fetch-base-path.ts) 改写路径。拦截器通过 AccessCodeGuard
          → layout.tsx 间接加载，依赖链在时序异常时导致 API 请求
          命中错误端点 → 404/403 → fallback 失败 → no loadable data。
        </Text>
      </Callout>

      <H3>数据流追踪</H3>

      <Table
        headers={["步骤", "路径", "状态"]}
        rows={[
          [
            "1. IndexedDB",
            "loadFromStorage → IndexedDB",
            "空（新浏览器）",
          ],
          [
            "2. API Fallback",
            "GET /api/classroom",
            "basePath 未拼接 → 404/403",
          ],
          [
            "3. 双路径失败",
            "getCurrentStage() === null",
            "throw no loadable data",
          ],
        ]}
        rowTone={["default", "warning", "danger"]}
      />

      <Divider />

      <H2>修复清单</H2>

      <Table
        headers={["#", "修复项", "文件", "状态"]}
        rows={[
          ["Fix 1", "前景生成 POST /api/classroom", "generation-preview/page.tsx", "完成"],
          ["Fix 2", "fetchClassroomFromApi warn 日志", "load-classroom.ts", "完成"],
          ["Fix 3", "onComplete 回存数据", "classroom/[id]/page.tsx", "完成"],
          ["Fix 4", "API 诊断日志", "api/classroom/route.ts", "完成"],
          ["Fix 5", "loadFromStorage 日志", "store/stage.ts", "完成"],
          ["E2E", "API fallback 测试", "e2e/tests/", "完成"],
          ["New 1", "fetchClassroomFromApi 显式 basePath", "load-classroom.ts L198-201", "完成"],
          ["New 2", "修复 TS 错误", "generation-preview/page.tsx", "完成"],
        ]}
        rowTone={[
          "default", "default", "default", "default",
          "default", "default", "success", "success",
        ]}
      />

      <Divider />

      <Card>
        <CardHeader title="关键代码变更">
          <Tag tone="info">lib/classroom/load-classroom.ts</Tag>
        </CardHeader>
        <CardBody>
          <CollapsibleSection title="fetchClassroomFromApi — 修复前后对比" defaultOpen>
            <Text size="small" tone="secondary">
              修复前：fetch(`/api/classroom?id=...`) → 依赖全局拦截器
            </Text>
            <Text size="small" tone="secondary">
              修复后：const basePath = process.env.NEXT_PUBLIC_BASE_PATH || &apos;&apos;;
              fetch(`${basePath}/api/classroom?id=...`)
            </Text>
          </CollapsibleSection>
        </CardBody>
      </Card>

      <Table
        headers={["场景", "URL", "结果"]}
        rows={[
          ["拦截器生效", "/openmaic/api/classroom?id=c4CoWD85kW", "正常"],
          ["拦截器失效（旧）", "/api/classroom?id=c4CoWD85kW", "404/403"],
          ["显式 basePath（新）", "/openmaic/api/classroom?id=c4CoWD85kW", "始终正确"],
        ]}
        rowTone={["default", "danger", "success"]}
      />

      <Text tone="secondary" size="small">
        task-564 全部修复已验证，TypeScript 编译通过。
      </Text>
    </Stack>
  );
}

import {
  Callout,
  Divider,
  Grid,
  H1,
  H2,
  Row,
  Stack,
  Stat,
  Table,
  Tag,
  Text,
} from "qoder/canvas";

export default function CourseAuditReport() {
  return (
    <Stack gap={20}>
      <H1>课程章节全面审计报告</H1>
      <Text tone="secondary" size="small">
        审计脚本: scripts/full-audit.mjs | 执行时间: 2026-07-30 23:56
      </Text>

      <Divider />

      <H2>总体概览</H2>
      <Grid columns={4} gap={16}>
        <Stat value="102/129" label="章节完成率 (79%)" tone="warning" />
        <Stat value="7/19" label="已完成课程" tone="success" />
        <Stat value="100" label="课堂JSON验证通过" tone="success" />
        <Stat value="194,931" label="典籍库真实段落" tone="success" />
      </Grid>

      <Divider />

      <H2>维度 1: 完整性核查</H2>
      <Text>
        19 门课程中 7 门全部完成，12 门正在生成，0 门未开始。总计 102/129 章节 (79%)。
      </Text>
      <Table
        headers={["课程名", "完成", "总数", "状态"]}
        rows={[
          ["哲学第一课", "5", "5", "已完成"],
          ["苏格拉底式职场", "6", "6", "已完成"],
          ["存在主义自救手册", "5", "5", "已完成"],
          ["哲学原著精读会", "5", "5", "已完成"],
          ["AI哲学辩论学院", "6", "6", "已完成"],
          ["哲学写作工坊", "5", "5", "已完成"],
          ["东西方哲学对话录", "6", "6", "已完成"],
          ["小小哲学家", "3", "4", "进行中"],
          ["哲学+X", "4", "5", "进行中"],
          ["中国哲学通识课", "4", "8", "进行中"],
          ["考研哲学冲刺营", "5", "6", "进行中"],
          ["伦理学实验室", "3", "5", "进行中"],
          ["哲学即生活", "3", "6", "进行中"],
          ["AI时代的哲学罗盘", "7", "10", "进行中"],
          ["哲学CEO", "8", "10", "进行中"],
          ["看见美", "7", "8", "进行中"],
          ["正义的尺度", "7", "10", "进行中"],
          ["科学的边界", "7", "10", "进行中"],
          ["哲学疗愈室", "6", "9", "进行中"],
        ]}
        density="compact"
      />

      <Divider />

      <H2>维度 2: 课堂数据验证</H2>
      <Grid columns={3} gap={16}>
        <Stat value="102" label="有效 classroom_id" />
        <Stat value="102/102" label="JSON 文件存在且完整" tone="success" />
        <Stat value="297" label="Job 文件总数" />
      </Grid>
      <Callout tone="warning">
        <Text size="small">
          100 个 Job 文件显示 failed 状态，但实际课堂数据已成功生成。
          原因: EPERM 错误发生在状态更新阶段（rename .tmp -&gt; .json），
          不影响已写入 classrooms/ 目录的课堂内容。
        </Text>
      </Callout>

      <Divider />

      <H2>维度 3: TTS 音频验证</H2>
      <Grid columns={3} gap={16}>
        <Stat value="10" label="抽样课堂数" />
        <Stat value="8" label="音频正常" tone="success" />
        <Stat value="2" label="音频缺失" tone="danger" />
      </Grid>
      <Text size="small" tone="secondary">
        缺失课堂: peE2UH4SdI (写作工坊ch3), d3aSNoUyiM (原著精读会ch3)
      </Text>

      <Divider />

      <H2>维度 4: RAG 内容注入检查</H2>
      <Grid columns={3} gap={16}>
        <Stat value="5/5" label="抽样课程含典籍引用" tone="success" />
        <Stat value="194,931" label="典籍库真实段落 (&gt;150字)" />
        <Stat value="0" label="占位符残留" tone="success" />
      </Grid>
      <Text size="small">
        典籍库总计 587,767 段落，其中 194,931 段为真实内容。
        抽样 5 门课程均检测到典籍引用痕迹。
      </Text>

      <Divider />

      <H2>维度 5: 错误与异常汇总</H2>
      <Table
        headers={["错误类别", "数量", "说明"]}
        rows={[
          ["EPERM 权限错误", "95", "杀毒软件锁定 .tmp 文件 rename 操作"],
          ["API 错误", "2", "DeepSeek API 返回异常"],
          ["其他错误", "3", "未分类错误"],
          [".tmp 残留文件", "87", "生成过程中断后遗留"],
        ]}
        rowTone={["danger", "warning", undefined, "warning"]}
        density="compact"
      />

      <Divider />

      <H2>维度 6: 内容质量抽样</H2>
      <Table
        headers={["课堂ID", "课程", "场景", "动作", "乱码", "重复"]}
        rows={[
          ["02Thj2RvcM", "AI哲学辩论学院", "9", "66", "OK", "OK"],
          ["PKU0aQGZ5u", "苏格拉底式职场", "6", "48", "OK", "OK"],
          ["cE-34CZYP8", "苏格拉底式职场", "7", "56", "OK", "OK"],
          ["KNN51StQTq", "正义的尺度", "9", "72", "OK", "OK"],
          ["uDPJHYmSvC", "科学的边界", "8", "62", "OK", "OK"],
        ]}
        density="compact"
      />
      <Text size="small" tone="secondary">
        5 个抽样课堂全部通过: 无乱码、无重复段落。空白 action 为结构性元素。
      </Text>

      <Divider />

      <H2>修复建议 (按优先级排序)</H2>

      <Stack gap={8}>
        <Callout tone="danger">
          <Stack gap={4}>
            <Text>
              <Tag tone="danger">P0</Tag>{" "}
              <Text weight="semibold">清理 .tmp 残留文件 + 杀毒软件排除</Text>
            </Text>
            <Text size="small">
              87 个 .tmp 文件残留于 data/classroom-jobs/。
              停止 OpenMAIC 后清理，并将该目录加入杀毒软件排除列表。
            </Text>
          </Stack>
        </Callout>

        <Callout tone="warning">
          <Stack gap={4}>
            <Text>
              <Tag tone="warning">P1</Tag>{" "}
              <Text weight="semibold">补全 2 个课堂 TTS 音频</Text>
            </Text>
            <Text size="small">
              peE2UH4SdI 和 d3aSNoUyiM 缺少音频文件。重新运行 TTS 生成脚本补全。
            </Text>
          </Stack>
        </Callout>

        <Callout tone="warning">
          <Stack gap={4}>
            <Text>
              <Tag tone="warning">P1</Tag>{" "}
              <Text weight="semibold">重试 5 个非 EPERM 失败 Job</Text>
            </Text>
            <Text size="small">
              检查 API Key 余额和网络连接，重新生成失败的课堂。
            </Text>
          </Stack>
        </Callout>

        <Callout tone="info">
          <Stack gap={4}>
            <Text>
              <Tag tone="info">P2</Tag>{" "}
              <Text weight="semibold">继续生成剩余 27 章节</Text>
            </Text>
            <Text size="small">
              12 门课程尚有 27 章节未完成。
              继续运行 batch-generate-chapters.mjs --all --workers=6。
            </Text>
          </Stack>
        </Callout>
      </Stack>

      <Divider />

      <Text tone="secondary" size="small">
        审计脚本: scripts/full-audit.mjs | 数据源: Philochora DB + data/classroom-jobs/ + data/classrooms/
      </Text>
    </Stack>
  );
}

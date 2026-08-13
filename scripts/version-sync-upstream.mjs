#!/usr/bin/env node
/**
 * version-sync-upstream.mjs — 上游版本同步脚本（OpenMAIC 专用）
 *
 * 用法:
 *   node scripts/version-sync-upstream.mjs 0.4.0
 *
 * 流程:
 *   1. 验证上游版本号格式（semver）
 *   2. 更新 VERSION 为上游版本号（去除 local）
 *   3. 更新 package.json 的 version 字段
 *   4. 在 CHANGELOG.md 顶部添加「上游同步」区块
 *   5. 提示用户打标签
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = dirname(SCRIPT_DIR);

const VERSION_FILE = join(PROJECT_ROOT, 'VERSION');
const PACKAGE_FILE = join(PROJECT_ROOT, 'package.json');
const CHANGELOG_FILE = join(PROJECT_ROOT, 'CHANGELOG.md');

// ── 工具函数 ──────────────────────────────────────────

function readVersion() {
  if (!existsSync(VERSION_FILE)) {
    console.error(`[ERROR] VERSION 文件不存在: ${VERSION_FILE}`);
    process.exit(1);
  }
  return readFileSync(VERSION_FILE, 'utf8').trim();
}

function validateSemver(versionStr) {
  const match = versionStr.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    console.error(`[ERROR] 版本号格式无效（必须是 MAJOR.MINOR.PATCH）: ${versionStr}`);
    process.exit(1);
  }
  return true;
}

function updatePackageJson(newVersion) {
  if (!existsSync(PACKAGE_FILE)) {
    console.warn(`[WARN] package.json 不存在，跳过: ${PACKAGE_FILE}`);
    return;
  }
  const pkg = JSON.parse(readFileSync(PACKAGE_FILE, 'utf8'));
  pkg.version = newVersion;
  writeFileSync(PACKAGE_FILE, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`[OK] package.json 已更新: ${pkg.version} → ${newVersion}`);
}

function updateChangelog(upstreamVersion) {
  if (!existsSync(CHANGELOG_FILE)) {
    console.warn(`[WARN] CHANGELOG.md 不存在，跳过: ${CHANGELOG_FILE}`);
    return;
  }

  const today = new Date().toISOString().split('T')[0];

  const newSection = `## [${upstreamVersion}] - ${today}

### 上游同步 (Upstream Sync)

- 同步上游 THU-MAIC/OpenMAIC v${upstreamVersion}
- 合并上游变更（详见上游 CHANGELOG）

---

`;

  const content = readFileSync(CHANGELOG_FILE, 'utf8');
  const insertIndex = content.search(/##\s*\[/);
  if (insertIndex === -1) {
    writeFileSync(CHANGELOG_FILE, content + '\n' + newSection);
  } else {
    const before = content.slice(0, insertIndex);
    const after = content.slice(insertIndex);
    writeFileSync(CHANGELOG_FILE, before + newSection + after);
  }
  console.log(`[OK] CHANGELOG.md 已添加 [${upstreamVersion}] 上游同步区块`);
}

// ── 主流程 ───────────────────────────────────────────

function main() {
  const upstreamVersion = process.argv[2];

  if (!upstreamVersion) {
    console.error('用法: node scripts/version-sync-upstream.mjs <upstream-version>');
    console.error('示例: node scripts/version-sync-upstream.mjs 0.4.0');
    process.exit(1);
  }

  validateSemver(upstreamVersion);

  const currentVersion = readVersion();

  console.log('========================================');
  console.log('  上游版本同步');
  console.log('========================================');
  console.log(`  上游版本: ${upstreamVersion}`);
  console.log(`  当前版本: ${currentVersion}`);
  console.log('');

  // 更新 VERSION 文件（去除 local）
  writeFileSync(VERSION_FILE, upstreamVersion);
  console.log(`[OK] VERSION 已更新: ${currentVersion} → ${upstreamVersion}`);

  // 更新 package.json
  updatePackageJson(upstreamVersion);

  // 更新 CHANGELOG.md
  updateChangelog(upstreamVersion);

  console.log('');
  console.log('========================================');
  console.log('  同步完成');
  console.log('========================================');
  console.log(`  下一步:`);
  console.log(`    1. 确认上游变更已合并到当前分支`);
  console.log(`    2. git add VERSION package.json CHANGELOG.md`);
  console.log(`    3. git commit -m "chore(upstream): sync to THU-MAIC/OpenMAIC v${upstreamVersion}"`);
  console.log(`    4. git tag v${upstreamVersion}-upstream`);
  console.log('========================================');
}

main();

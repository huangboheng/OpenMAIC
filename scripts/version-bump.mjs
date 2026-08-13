#!/usr/bin/env node
/**
 * version-bump.mjs — 语义化版本升级脚本
 *
 * 用法:
 *   node scripts/version-bump.mjs patch   # PATCH +1
 *   node scripts/version-bump.mjs minor   # MINOR +1, PATCH=0
 *   node scripts/version-bump.mjs major   # MAJOR +1, MINOR=0, PATCH=0
 *   node scripts/version-bump.mjs hotfix  # PATCH +1（标记为热修复）
 *
 * 流程:
 *   1. 读取当前 VERSION
 *   2. 根据参数计算新版本号
 *   3. 更新 VERSION 文件
 *   4. 更新 package.json 的 version 字段
 *   5. 在 CHANGELOG.md 顶部添加版本占位区块
 *   6. 输出变更摘要
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

const BUMP_TYPES = ['patch', 'minor', 'major', 'hotfix'];

// ── 工具函数 ──────────────────────────────────────────

function readVersion() {
  if (!existsSync(VERSION_FILE)) {
    console.error(`[ERROR] VERSION 文件不存在: ${VERSION_FILE}`);
    process.exit(1);
  }
  return readFileSync(VERSION_FILE, 'utf8').trim();
}

function parseVersion(versionStr) {
  // 支持格式: 0.3.1 或 0.3.1+local.1
  const match = versionStr.match(/^(\d+)\.(\d+)\.(\d+)(?:\+local\.(\d+))?$/);
  if (!match) {
    console.error(`[ERROR] 版本号格式无效: ${versionStr}`);
    process.exit(1);
  }
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    local: match[4] ? parseInt(match[4], 10) : 0,
  };
}

function bumpVersion(parsed, type) {
  const { major, minor, patch } = parsed;
  switch (type) {
    case 'major':
      return { major: major + 1, minor: 0, patch: 0, local: 0 };
    case 'minor':
      return { major, minor: minor + 1, patch: 0, local: 0 };
    case 'patch':
    case 'hotfix':
      return { major, minor, patch: patch + 1, local: 0 };
    default:
      console.error(`[ERROR] 未知的升级类型: ${type}`);
      process.exit(1);
  }
}

function formatVersion({ major, minor, patch, local }) {
  if (local > 0) {
    return `${major}.${minor}.${patch}+local.${local}`;
  }
  return `${major}.${minor}.${patch}`;
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

function updateChangelog(newVersion, type) {
  if (!existsSync(CHANGELOG_FILE)) {
    console.warn(`[WARN] CHANGELOG.md 不存在，跳过: ${CHANGELOG_FILE}`);
    return;
  }

  const today = new Date().toISOString().split('T')[0];
  const typeLabel = type === 'hotfix' ? '紧急热修复 (Hotfix)' : '自有功能 (Own Feature)';
  const header = type === 'hotfix' ? '### 紧急热修复 (Hotfix)' : '### 自有功能 (Own Feature)';

  const newSection = `## [${newVersion}] - ${today}

${header}

- xxx

### Bug 修复

- xxx

---

`;

  const content = readFileSync(CHANGELOG_FILE, 'utf8');
  // 在第一个 ## [ 之前插入新版本区块
  const insertIndex = content.search(/##\s*\[/);
  if (insertIndex === -1) {
    // 没有版本区块，追加到文件末尾
    writeFileSync(CHANGELOG_FILE, content + '\n' + newSection);
  } else {
    const before = content.slice(0, insertIndex);
    const after = content.slice(insertIndex);
    writeFileSync(CHANGELOG_FILE, before + newSection + after);
  }
  console.log(`[OK] CHANGELOG.md 已添加 [${newVersion}] 区块`);
}

// ── 主流程 ───────────────────────────────────────────

function main() {
  const type = process.argv[2];

  if (!type || !BUMP_TYPES.includes(type)) {
    console.error(`用法: node scripts/version-bump.mjs [${BUMP_TYPES.join('|')}]`);
    process.exit(1);
  }

  const currentVersion = readVersion();
  const parsed = parseVersion(currentVersion);
  const newParsed = bumpVersion(parsed, type);
  const newVersion = formatVersion(newParsed);

  console.log('========================================');
  console.log('  版本升级');
  console.log('========================================');
  console.log(`  类型: ${type}`);
  console.log(`  当前: ${currentVersion}`);
  console.log(`  目标: ${newVersion}`);
  console.log('');

  // 更新 VERSION 文件
  writeFileSync(VERSION_FILE, newVersion);
  console.log(`[OK] VERSION 已更新: ${currentVersion} → ${newVersion}`);

  // 更新 package.json
  updatePackageJson(newVersion);

  // 更新 CHANGELOG.md
  updateChangelog(newVersion, type);

  console.log('');
  console.log('========================================');
  console.log('  升级完成');
  console.log('========================================');
  console.log(`  下一步:`);
  console.log(`    1. 编辑 CHANGELOG.md，补充变更详情`);
  console.log(`    2. git add VERSION package.json CHANGELOG.md`);
  console.log(`    3. git commit -m "chore(release): bump version to ${newVersion}"`);
  const tagSuffix = type === 'hotfix' ? '-hotfix' : '';
  console.log(`    4. git tag v${newVersion}${tagSuffix}`);
  console.log('========================================');
}

main();

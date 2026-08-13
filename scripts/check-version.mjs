#!/usr/bin/env node
/**
 * check-version.mjs — 版本号强制检查脚本
 *
 * 检查项:
 *   1. VERSION 文件存在且格式有效
 *   2. package.json 的 version 字段与 VERSION 文件一致
 *   3. 提交时 VERSION 或 package.json 有变更（要求版本号已更新）
 *
 * 用法:
 *   node scripts/check-version.mjs [pre-commit|pre-push]
 *
 * 环境变量:
 *   SKIP_VERSION=1 — 跳过版本检查（需配合 SKIP_REASON）
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { execSync } from 'child_process';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = dirname(SCRIPT_DIR);

const VERSION_FILE = join(PROJECT_ROOT, 'VERSION');
const PACKAGE_FILE = join(PROJECT_ROOT, 'package.json');

// ── 工具函数 ──────────────────────────────────────────

function logError(msg) {
  console.error(`[VERSION-CHECK] ❌ ${msg}`);
}

function logOk(msg) {
  console.log(`[VERSION-CHECK] ✅ ${msg}`);
}

function logWarn(msg) {
  console.log(`[VERSION-CHECK] ⚠️  ${msg}`);
}

function readVersion() {
  if (!existsSync(VERSION_FILE)) {
    logError(`VERSION 文件不存在: ${VERSION_FILE}`);
    return null;
  }
  return readFileSync(VERSION_FILE, 'utf8').trim();
}

function readPackageVersion() {
  if (!existsSync(PACKAGE_FILE)) {
    logWarn(`package.json 不存在，跳过: ${PACKAGE_FILE}`);
    return null;
  }
  const pkg = JSON.parse(readFileSync(PACKAGE_FILE, 'utf8'));
  return pkg.version || null;
}

function validateVersion(versionStr) {
  // 支持: 0.3.1 或 0.3.1+local.1
  return /^\d+\.\d+\.\d+(?:\+local\.\d+)?$/.test(versionStr);
}

function getStagedFiles() {
  try {
    const output = execSync('git diff --cached --name-only --diff-filter=ACMR', {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
    });
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// ── 检查逻辑 ──────────────────────────────────────────

async function checkPreCommit() {
  const version = readVersion();
  if (!version) return false;

  if (!validateVersion(version)) {
    logError(`VERSION 文件格式无效: "${version}"（期望: MAJOR.MINOR.PATCH 或 MAJOR.MINOR.PATCH+local.N）`);
    return false;
  }

  const pkgVersion = readPackageVersion();
  if (pkgVersion && pkgVersion !== version) {
    logError(`VERSION 文件 (${version}) 与 package.json (${pkgVersion}) 不一致`);
    console.log('  修复: node scripts/version-bump.mjs patch');
    return false;
  }

  // 检查本次提交是否包含 VERSION/package.json 变更
  const stagedFiles = await getStagedFiles();
  const hasVersionChange = stagedFiles.includes('VERSION') || stagedFiles.includes('package.json');

  if (!hasVersionChange) {
    logError('提交未包含 VERSION 或 package.json 的变更');
    console.log('  每次提交必须更新版本号（即使只是文档/配置变更）');
    console.log('  修复: node scripts/version-bump.mjs patch');
    console.log('  跳过: SKIP_VERSION=1 git commit');
    return false;
  }

  logOk(`版本号检查通过: ${version}`);
  return true;
}

async function checkPrePush() {
  // pre-push 检查: 确保版本号已递增（与 origin/main 对比）
  try {
    const localVersion = readVersion();
    if (!localVersion) return false;

    // 获取 origin/main 上的 VERSION
    let remoteVersion;
    try {
      remoteVersion = execSync('git show origin/main:VERSION', {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
      }).trim();
    } catch {
      logWarn('无法获取 origin/main 的 VERSION，跳过版本递增检查');
      return true;
    }

    if (localVersion === remoteVersion) {
      logError(`版本号未更新: ${localVersion}（与 origin/main 相同）`);
      console.log('  推送前请先升级版本号');
      console.log('  修复: node scripts/version-bump.mjs patch');
      console.log('  跳过: SKIP_VERSION=1 git push');
      return false;
    }

    logOk(`版本号已更新: ${remoteVersion} → ${localVersion}`);
    return true;
  } catch (err) {
    logWarn(`版本检查异常: ${err.message}`);
    return true; // 异常时不阻断
  }
}

// ── 主流程 ───────────────────────────────────────────

async function main() {
  const hookType = process.argv[2] || 'pre-commit';

  // 检查 SKIP_VERSION 逃生口
  if (process.env.SKIP_VERSION === '1') {
    logWarn('SKIP_VERSION=1 — 跳过版本检查');
    return 0;
  }

  console.log(`[VERSION-CHECK] 运行 ${hookType} 版本检查...`);

  let ok;
  if (hookType === 'pre-push') {
    ok = await checkPrePush();
  } else {
    ok = await checkPreCommit();
  }

  return ok ? 0 : 1;
}

main().then(code => process.exit(code)).catch(err => {
  logError(`脚本异常: ${err.message}`);
  process.exit(1);
});

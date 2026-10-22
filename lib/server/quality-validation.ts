/**
 * Post-generation quality validation for classroom content.
 *
 * Three layers:
 * - L1: Structural validation (wraps @openmaic/dsl validators, zero LLM cost)
 * - L2: Per-scene content quality judge (1 LLM call per scene)
 * - L3: Cross-scene coherence check (1 LLM call total)
 *
 * Gated by OPENMAIC_ENABLE_QUALITY_VALIDATION. When disabled, zero behavior change.
 */

import { generateText, type LanguageModel } from 'ai';
import { validateScene, type ValidationResult } from '@openmaic/dsl';
import type { SceneOutline, GeneratedSceneContent } from '@openmaic/generation';
import type { Action } from '@/lib/types/action';
import { createLogger } from '@/lib/logger';
import { isQualityValidationEnabled } from '@/lib/config/feature-flags';

export { isQualityValidationEnabled };

const log = createLogger('QualityValidation');

const MAX_QUALITY_RETRIES = 2;
const PASS_THRESHOLD = 3;

// ── Types ─────────────────────────────────────────────────────────────────

export interface QualityDimension {
  score: number;
  pass: boolean;
}

export interface SceneQualityVerdict {
  topicRelevance: QualityDimension;
  factualPlausibility: QualityDimension;
  completeness: QualityDimension;
  pedagogicalValue: QualityDimension;
  overallPass: boolean;
  issues: string[];
}

export interface SceneQualityReport {
  sceneTitle: string;
  structuralValid: boolean;
  structuralErrors?: string[];
  quality?: SceneQualityVerdict;
  qualityCheckError?: string;
  passed: boolean;
  attempts: number;
}

export interface CrossSceneCoherenceReport {
  outlineCoverage: QualityDimension & { uncoveredTopics: string[] };
  logicalProgression: QualityDimension;
  overallPass: boolean;
  issues: string[];
}

export interface QualityReport {
  sceneReports: SceneQualityReport[];
  coherenceReport?: CrossSceneCoherenceReport;
  summary: {
    totalScenes: number;
    passed: number;
    skipped: number;
    coherencePassed: boolean | null;
    overallVerdict: 'pass' | 'pass_with_warnings' | 'fail' | 'skipped';
  };
}

// ── L1: Structural validation ─────────────────────────────────────────────

export function validateSceneStructure(scene: unknown): { valid: boolean; errors: string[] } {
  const result: ValidationResult = validateScene(scene);
  if (result.valid) return { valid: true, errors: [] };
  return {
    valid: false,
    errors: result.errors.map((e) => `${e.path}: ${e.message}`),
  };
}

// ── L2: Per-scene quality judge ───────────────────────────────────────────

const SCENE_QUALITY_SYSTEM_PROMPT = `You are evaluating the quality of a single scene in an AI-generated course.

You will receive:
1. The course requirement/topic
2. The scene outline (title, type, key points, teaching objective)
3. A summary of the generated scene content
4. A summary of the generated actions (what happens in the scene)

Rate each dimension 1-5:
- topic_relevance: Does the scene content address the outline topic?
- factual_plausibility: Are claims/facts reasonable and not obviously wrong?
- completeness: Does the scene cover the key points expected for this topic?
- pedagogical_value: Does the scene teach something clearly?

Overall pass: ALL dimensions score >= ${PASS_THRESHOLD}.

Respond with ONLY a JSON object (no markdown fences):
{"topicRelevance":{"score":N},"factualPlausibility":{"score":N},"completeness":{"score":N},"pedagogicalValue":{"score":N},"overallPass":true/false,"issues":["brief issue 1"]}`;

function summarizeContent(content: GeneratedSceneContent): string {
  if ('elements' in content) {
    const slides = content.elements;
    return `${slides.length} slide(s): ${slides.map((s) => ('title' in s ? (s.title as string) || '(untitled)' : '(untitled)')).join(', ')}`;
  }
  if ('questions' in content) {
    return `${content.questions.length} quiz question(s)`;
  }
  if ('widgetType' in content) {
    return `Interactive widget: ${content.widgetType}`;
  }
  if ('projectType' in content) {
    return `PBL project: ${content.projectType} — ${(content as Record<string, unknown>).projectName ?? '(unnamed)'}`;
  }
  return '(unknown content type)';
}

function summarizeActions(actions: Action[]): string {
  if (actions.length === 0) return '(no actions)';
  const byType: Record<string, number> = {};
  for (const a of actions) {
    byType[a.type] = (byType[a.type] || 0) + 1;
  }
  return Object.entries(byType)
    .map(([type, count]) => `${type}×${count}`)
    .join(', ');
}

export async function judgeSceneQuality(
  model: LanguageModel,
  requirement: string,
  outline: SceneOutline,
  content: GeneratedSceneContent,
  actions: Action[],
): Promise<SceneQualityVerdict> {
  const prompt = `Requirement: "${requirement}"

Scene outline:
- Title: ${outline.title}
- Type: ${outline.type}
- Key points: ${outline.keyPoints.join(', ')}
- Teaching objective: ${outline.teachingObjective || '(none specified)'}

Generated content summary: ${summarizeContent(content)}
Generated actions summary: ${summarizeActions(actions)}`;

  const result = await generateText({
    model,
    system: SCENE_QUALITY_SYSTEM_PROMPT,
    prompt,
    temperature: 0,
  });

  try {
    const text = result.text.replace(/```json\s*|\s*```/g, '').trim();
    const parsed = JSON.parse(text) as Record<string, unknown>;

    const dimensions = ['topicRelevance', 'factualPlausibility', 'completeness', 'pedagogicalValue'] as const;
    const verdict: SceneQualityVerdict = {
      topicRelevance: { score: 0, pass: false },
      factualPlausibility: { score: 0, pass: false },
      completeness: { score: 0, pass: false },
      pedagogicalValue: { score: 0, pass: false },
      overallPass: false,
      issues: [],
    };

    let allPass = true;
    for (const dim of dimensions) {
      const raw = parsed[dim] as Record<string, unknown> | undefined;
      const score = typeof raw?.score === 'number' ? raw.score : 1;
      const pass = score >= PASS_THRESHOLD;
      verdict[dim] = { score, pass };
      if (!pass) allPass = false;
    }

    verdict.overallPass = allPass;
    verdict.issues = Array.isArray(parsed.issues)
      ? (parsed.issues as string[]).filter((s) => typeof s === 'string')
      : [];

    return verdict;
  } catch {
    log.warn(`Failed to parse quality judge response: ${result.text.slice(0, 200)}`);
    return {
      topicRelevance: { score: 1, pass: false },
      factualPlausibility: { score: 1, pass: false },
      completeness: { score: 1, pass: false },
      pedagogicalValue: { score: 1, pass: false },
      overallPass: false,
      issues: [`Failed to parse judge response: ${result.text.slice(0, 100)}`],
    };
  }
}

// ── L3: Cross-scene coherence ─────────────────────────────────────────────

const COHERENCE_SYSTEM_PROMPT = `You are evaluating the coherence of an AI-generated course.

You will receive:
1. The course requirement
2. The planned outline (scene titles in order)
3. The actually generated scenes (titles, types, action counts)

Evaluate:
- outline_coverage: Does every planned outline item have a corresponding generated scene? List any uncovered topics.
- logical_progression: Do the generated scenes flow logically from introduction through development to conclusion?

Score each 1-5. Pass if >= ${PASS_THRESHOLD}.

Respond with ONLY a JSON object (no markdown fences):
{"outlineCoverage":{"score":N,"uncoveredTopics":[]},"logicalProgression":{"score":N},"overallPass":true/false,"issues":[]}`;

export async function judgeCoherence(
  model: LanguageModel,
  requirement: string,
  outlines: SceneOutline[],
  sceneSummaries: { title: string; type: string; actionCount: number }[],
): Promise<CrossSceneCoherenceReport> {
  const outlineList = outlines.map((o, i) => `${i + 1}. [${o.type}] ${o.title}`).join('\n');
  const sceneList = sceneSummaries
    .map((s, i) => `${i + 1}. [${s.type}] ${s.title} (${s.actionCount} actions)`)
    .join('\n');

  const prompt = `Requirement: "${requirement}"

Planned outline:
${outlineList}

Generated scenes:
${sceneList}`;

  const result = await generateText({
    model,
    system: COHERENCE_SYSTEM_PROMPT,
    prompt,
    temperature: 0,
  });

  try {
    const text = result.text.replace(/```json\s*|\s*```/g, '').trim();
    const parsed = JSON.parse(text) as Record<string, unknown>;

    const coverageRaw = parsed.outlineCoverage as Record<string, unknown> | undefined;
    const coverageScore = typeof coverageRaw?.score === 'number' ? coverageRaw.score : 1;
    const uncoveredTopics = Array.isArray(coverageRaw?.uncoveredTopics)
      ? (coverageRaw.uncoveredTopics as string[]).filter((s) => typeof s === 'string')
      : [];

    const progressionRaw = parsed.logicalProgression as Record<string, unknown> | undefined;
    const progressionScore = typeof progressionRaw?.score === 'number' ? progressionRaw.score : 1;

    const outlineCoverage = {
      score: coverageScore,
      pass: coverageScore >= PASS_THRESHOLD,
      uncoveredTopics,
    };
    const logicalProgression = {
      score: progressionScore,
      pass: progressionScore >= PASS_THRESHOLD,
    };

    return {
      outlineCoverage,
      logicalProgression,
      overallPass: outlineCoverage.pass && logicalProgression.pass,
      issues: Array.isArray(parsed.issues)
        ? (parsed.issues as string[]).filter((s) => typeof s === 'string')
        : [],
    };
  } catch {
    log.warn(`Failed to parse coherence judge response: ${result.text.slice(0, 200)}`);
    return {
      outlineCoverage: { score: 1, pass: false, uncoveredTopics: [] },
      logicalProgression: { score: 1, pass: false },
      overallPass: false,
      issues: [`Failed to parse coherence judge response: ${result.text.slice(0, 100)}`],
    };
  }
}

// ── Quality gate retry wrapper ────────────────────────────────────────────

export interface QualityGateOptions {
  label: string;
  onRetry?: (attempt: number, issues: string[]) => void;
  onSkip?: (issues: string[]) => void;
}

export interface QualityGateValidationResult<T> {
  pass: boolean;
  issues: string[];
  /** Optional partial report data to attach regardless of pass/fail. */
  report?: Partial<SceneQualityReport>;
}

/**
 * Wrap a generation + validation cycle. On quality failure, retries up to
 * MAX_QUALITY_RETRIES total attempts. Returns null if all attempts fail
 * (caller should skip this scene).
 */
export async function withQualityGate<T>(
  generate: (attempt: number) => Promise<T | null>,
  validate: (result: T) => Promise<QualityGateValidationResult<T>>,
  options: QualityGateOptions,
): Promise<{ result: T | null; attempts: number; lastIssues: string[] }> {
  let lastIssues: string[] = [];

  for (let attempt = 1; attempt <= MAX_QUALITY_RETRIES; attempt++) {
    const result = await generate(attempt);
    if (!result) {
      lastIssues = ['generation returned null'];
      if (attempt < MAX_QUALITY_RETRIES) {
        options.onRetry?.(attempt, lastIssues);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      continue;
    }

    const { pass, issues } = await validate(result);
    if (pass) {
      return { result, attempts: attempt, lastIssues: [] };
    }

    lastIssues = issues;
    if (attempt < MAX_QUALITY_RETRIES) {
      options.onRetry?.(attempt, issues);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  options.onSkip?.(lastIssues);
  return { result: null, attempts: MAX_QUALITY_RETRIES, lastIssues };
}

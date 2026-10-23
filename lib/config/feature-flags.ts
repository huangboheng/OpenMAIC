/**
 * Feature flags. Public flags come from `NEXT_PUBLIC_*` env vars, which
 * Next.js inlines at build time so they are safe to read from client
 * components. Server-only flags must not use the `NEXT_PUBLIC_` prefix.
 *
 * Truthy values: `'true'` or `'1'`. Unless a flag documents a different
 * default, anything else (including unset) is treated as disabled.
 */

function readBoolean(envValue: string | undefined): boolean {
  return envValue === 'true' || envValue === '1';
}

/**
 * Server-only gate for durable background agent execution. This is evaluated
 * at process runtime and is never exposed to the browser bundle.
 */
export function isAgentRuntimeEnabled(): boolean {
  return readBoolean(process.env.OPENMAIC_AGENT_RUNTIME_ENABLED);
}

/** The Node runtime can start the runner only with a non-empty database URL. */
export function isAgentRuntimeConfigured(): boolean {
  return isAgentRuntimeEnabled() && Boolean(process.env.DATABASE_URL?.trim());
}

/**
 * Server-only gate for the application's own home page and generation flow.
 * Default OFF: hosted deployments (the Philochora sub-path mount) expose only
 * classroom pages. Local development opts in with
 * `OPENMAIC_HOME_ENABLED=true` in `.env.local`.
 *
 * The value is enforced at the page (`app/page.tsx`) and proxy layers; the
 * root layout also passes the boolean to the client so classroom "back to
 * home" affordances can target the host site when the home page is disabled.
 * Never rename this to a `NEXT_PUBLIC_*` variable.
 */
export function isHomePageEnabled(): boolean {
  return readBoolean(process.env.OPENMAIC_HOME_ENABLED);
}

/**
 * Server-side persistence is available: documents, runtime rows and assets are
 * durable and owner-scoped. This is the same condition the persistence route
 * itself keys on, and it is strictly weaker than
 * {@link isAgentRuntimeConfigured} — every deployment that runs the agent
 * runtime also has persistence, but persistence runs perfectly well without it.
 *
 * Anything that describes a persisted course (who owns it, whether it is
 * published) must gate on THIS, not on the agent runtime: the persistence
 * route resolves an owner for every request and the owner-bound document store
 * records one for every course, so those facts exist whether or not the runtime
 * is enabled.
 *
 * The course library and folder routes (`/api/stages/**`, `/api/folders/**`)
 * gate on this too: they need the database and nothing the runtime adds.
 */
export function isServerPersistenceConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

/**
 * Build-time workbench affordance. This public flag is separate from the
 * server runtime gate because Next.js inlines NEXT_PUBLIC values into client
 * bundles; both gates must be on before a workbench page is reachable.
 */
export function isProWorkbenchEnabled(): boolean {
  return readBoolean(process.env.NEXT_PUBLIC_PRO_WORKBENCH_ENABLED);
}

/**
 * MAIC Editor (Pro mode) gate. Default OFF — gates only the Pro toggle
 * affordance in `Header`. The `StageMode` type union is unaffected so
 * existing code paths typecheck identically with the flag in either
 * state.
 *
 * Implied by the Pro workbench flag: the workbench IS Pro mode, and a
 * workbench build without the editor toggle has no way to edit a course.
 * The standalone flag remains for deployments that want the classroom
 * editor without the workbench.
 */
export function isMaicEditorEnabled(): boolean {
  return isProWorkbenchEnabled() || readBoolean(process.env.NEXT_PUBLIC_MAIC_EDITOR_ENABLED);
}

/**
 * Experimental playback canvas renderer. Default OFF so classroom playback uses
 * the legacy in-app renderer unless explicitly enabled in `.env.local`.
 */
export function isPlaybackRendererEnabled(): boolean {
  return readBoolean(process.env.NEXT_PUBLIC_MAIC_PLAYBACK_RENDERER_ENABLED);
}

/**
 * Experimental Pro-mode slide editor renderer. Default OFF so professional
 * editing keeps using the legacy in-app editor canvas unless explicitly enabled
 * in `.env.local`.
 */
export function isEditorRendererEnabled(): boolean {
  return readBoolean(process.env.NEXT_PUBLIC_MAIC_EDITOR_RENDERER_ENABLED);
}

/**
 * Unified playback courseware-reference gate for PPT and Interactive scenes.
 * Default OFF and independently disableable while Pi chat remains available.
 */
export function isCoursewareReferenceEnabled(): boolean {
  return readBoolean(process.env.NEXT_PUBLIC_COURSEWARE_REFERENCE_ENABLED);
}

/**
 * Server-only selector for the Pi Child execution harness. Default OFF keeps
 * the existing Legacy JSON-action Child runtime.
 */
export function isPiNativeChildRuntimeEnabled(): boolean {
  return readBoolean(process.env.OPENMAIC_ENABLE_PI_NATIVE_CHILD_RUNTIME);
}

/**
 * Server-only capability gate for Native Child Spotlight. This flag never
 * selects the Child runtime and has no effect while the Legacy harness is used.
 */
export function isPiNativeChildSpotlightEnabled(): boolean {
  return readBoolean(process.env.OPENMAIC_ENABLE_PI_NATIVE_CHILD_SPOTLIGHT);
}

/**
 * Server-authoritative gate for the vocational task-engine generation path.
 * Default OFF. When disabled, requests that include taskEngineMode must
 * silently fall back to the ordinary standard / interactive generation paths.
 */
export function isVocationalTaskEngineEnabled(): boolean {
  return readBoolean(process.env.OPENMAIC_ENABLE_VOCATIONAL);
}

export function resolveVocationalActive(
  requirements?: { taskEngineMode?: boolean } | null,
): boolean {
  return Boolean(requirements?.taskEngineMode) && isVocationalTaskEngineEnabled();
}

/**
 * Optional client-only affordance for exposing the experimental vocational
 * test toggle. This is not a security or routing gate.
 */
export function shouldShowVocationalTestUi(): boolean {
  return readBoolean(process.env.NEXT_PUBLIC_SHOW_VOCATIONAL_TEST_UI);
}

/**
 * Settings panel gate. Default OFF — hides the settings dialog and every
 * settings entry point (header gear button, "Configure Provider" toolbar
 * affordance, media popover "Advanced Settings" link). Intended for managed
 * deployments (e.g. embedded as a backend behind another product) where
 * providers/keys/models are configured server-side and end users must not
 * reach model / API-key / base-URL configuration. Enable for standalone or
 * development use with NEXT_PUBLIC_SETTINGS_ENABLED=true.
 */
export function isSettingsEnabled(): boolean {
  return readBoolean(process.env.NEXT_PUBLIC_SETTINGS_ENABLED);
}

/** Pi is the only classroom chat runtime; kept for legacy call sites. */
export function isPiChatEnabled(): boolean {
  return true;
}

/**
 * Experimental classroom video export (Hyperframes composition ZIP, #865).
 * Default OFF — gates only the "Export Video" affordance in the export menu.
 * The emitter/compiler code paths are unaffected; this hides the UI entry
 * point until the render pipeline (#866) lands.
 */
export function isVideoExportEnabled(): boolean {
  return readBoolean(process.env.NEXT_PUBLIC_ENABLE_VIDEO_EXPORT);
}

/** Experimental PPTX import entry point. Default OFF. */
export function isPptxImportEnabled(): boolean {
  return readBoolean(process.env.NEXT_PUBLIC_ENABLE_PPTX_IMPORT);
}

/**
 * Server-only gate for post-generation quality validation. Default OFF.
 * When enabled, each generated scene passes through structural validation
 * (L1) and an LLM-as-judge quality check (L2) before persistence; a
 * cross-scene coherence check (L3) runs after all scenes are generated.
 * Failed scenes are retried once, then skipped if still failing.
 */
export function isQualityValidationEnabled(): boolean {
  return readBoolean(process.env.OPENMAIC_ENABLE_QUALITY_VALIDATION);
}

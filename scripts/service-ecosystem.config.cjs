/**
 * Service-mode aggregated PM2 ecosystem for pm2-windows-service.
 *
 * pm2-windows-service runs `pm2 start <PM2_SERVICE_SCRIPTS>` on service
 * startup, and cannot pass extra args like `--only philochora`. This file
 * aggregates the apps from both projects' dev ecosystem configs into a
 * single config file so the service can bring up everything in one shot.
 *
 * App set mirrors what the local dev environment actually runs:
 *   - openmaic          (from OpenMAIC's own ecosystem.dev.config.cjs)
 *   - philochora        (from Philochora's ecosystem.dev.config.cjs)
 *   - philochora-admin  (from Philochora's ecosystem.dev.config.cjs)
 *
 * The `openmaic` app defined inside Philochora's config is intentionally
 * excluded (duplicate of the OpenMAIC one with conflicting restart policy).
 */
const openmaic = require('E:/hermes/workspace/openmaic/ecosystem.dev.config.cjs');
const philochora = require('E:/hermes/workspace/Philochora/ecosystem.dev.config.cjs');

module.exports = {
  apps: [
    ...openmaic.apps,
    ...philochora.apps.filter(
      (app) => app.name === 'philochora' || app.name === 'philochora-admin'
    ),
  ],
};

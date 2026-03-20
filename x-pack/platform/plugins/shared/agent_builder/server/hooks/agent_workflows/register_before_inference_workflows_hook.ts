/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { HookLifecycle, HookExecutionMode } from '@kbn/agent-builder-server';
import type { Logger } from '@kbn/logging';
import type { WorkflowsServerPluginSetup } from '@kbn/workflows-management-plugin/server';
import type { InternalSetupServices, InternalStartServices } from '../../services';
import { runBeforeInferenceWorkflows } from './run_before_inference_workflows';

export interface RegisterBeforeInferenceWorkflowsHookDeps {
  workflowsManagement?: WorkflowsServerPluginSetup;
  logger: Logger;
  getInternalServices: () => InternalStartServices;
}

/**
 * Registers the beforeInference hook that runs workflows configured for
 * the beforeInference lifecycle. When workflows management is not available,
 * registration is skipped and the hook is a no-op.
 */
export function registerBeforeInferenceWorkflowsHook(
  serviceSetups: InternalSetupServices,
  deps: RegisterBeforeInferenceWorkflowsHookDeps
): void {
  if (!deps.workflowsManagement) {
    deps.logger.debug('BeforeInference workflows hook skipped: workflows management not available');
    return;
  }

  const workflowApi = deps.workflowsManagement.management;
  const logger = deps.logger.get('beforeInferenceWorkflows');

  serviceSetups.hooks.register({
    id: 'before-inference-workflows',
    hooks: {
      [HookLifecycle.beforeInference]: {
        mode: HookExecutionMode.blocking,
        handler: async (context) => {
          const start = Date.now();
          try {
            const result = await runBeforeInferenceWorkflows({
              context,
              workflowApi,
              getInternalServices: deps.getInternalServices,
              logger,
              // Tight timeout: this hook blocks inference; keep well below the
              // overall request timeout. 30 s is a practical maximum.
              completionTimeoutSec: 30,
            });
            logger.debug(`[beforeInference] workflows completed in ${Date.now() - start}ms`);
            return result;
          } catch (err) {
            // Fail-open: log the error but do not block inference.
            // A failed beforeInference hook should not prevent the user's request
            // from completing.
            logger.error(
              `[beforeInference] workflow execution failed (${Date.now() - start}ms): ${
                err instanceof Error ? err.message : String(err)
              }`
            );
            return;
          }
        },
      },
    },
  });
}

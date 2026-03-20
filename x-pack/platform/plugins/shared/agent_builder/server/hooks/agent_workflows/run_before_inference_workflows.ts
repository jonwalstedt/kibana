/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type {
  BeforeInferenceHookContext,
  HookHandlerResult,
  HookLifecycle,
} from '@kbn/agent-builder-server';
import { ExecutionStatus } from '@kbn/workflows';
import {
  createWorkflowExecutionError,
  isConversationNotFoundError,
} from '@kbn/agent-builder-common';
import { AGENT_BUILDER_EXPERIMENTAL_FEATURES_SETTING_ID } from '@kbn/management-settings-ids';
import type { Logger } from '@kbn/logging';
import type { WorkflowsServerPluginSetup } from '@kbn/workflows-management-plugin/server';
import type { IUiSettingsClient } from '@kbn/core/server';
import { WORKFLOWS_UI_SETTING_ID } from '@kbn/workflows';
import type { InternalStartServices } from '../../services/types';
import { getCurrentSpaceId } from '../../utils/spaces';
import { executeWorkflow } from '../../services/workflow/execute_workflow';

type WorkflowApi = WorkflowsServerPluginSetup['management'];

export interface RunBeforeInferenceWorkflowsParams {
  context: BeforeInferenceHookContext;
  workflowApi: WorkflowApi;
  getInternalServices: () => InternalStartServices;
  logger: Logger;
  /**
   * Per-workflow completion timeout in seconds. Defaults to 30 s to keep the
   * beforeInference hook from blocking inference for too long.
   */
  completionTimeoutSec?: number;
}

/**
 * Merges two inferenceConfig records. Arrays are concatenated; scalar values
 * use last-writer-wins.
 */
function mergeConfigs(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    if (Array.isArray(value) && Array.isArray(merged[key])) {
      merged[key] = [...(merged[key] as unknown[]), ...value];
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * Runs workflows configured for the beforeInference lifecycle and returns
 * their merged output as `inferenceConfig`. Workflow output is passed through
 * as-is; validation is the responsibility of the workflow and its consumers.
 *
 * Workflow IDs are resolved from:
 *   1. agent.configuration.lifecycle_workflows?.beforeInference (preferred)
 */
export async function runBeforeInferenceWorkflows({
  context,
  workflowApi,
  getInternalServices,
  logger,
  completionTimeoutSec = 30,
}: RunBeforeInferenceWorkflowsParams): Promise<void | HookHandlerResult<HookLifecycle.beforeInference>> {
  const { spaces, uiSettings, savedObjects, agents, conversations } = getInternalServices();
  const soClient = savedObjects.getScopedClient(context.request);
  const uiSettingsClient = uiSettings.asScopedToClient(soClient);

  const isEnabled = await isBeforeInferenceWorkflowsEnabled(uiSettingsClient);
  if (!isEnabled) {
    return;
  }

  const workflowIds = await getBeforeInferenceWorkflowIds(context, agents);
  if (!workflowIds.length) {
    return;
  }

  const spaceId = getCurrentSpaceId({ request: context.request, spaces });

  // Fetch replacementsId from the conversation for session continuity across turns.
  // Only fetched here (not seeded by the caller) so agent builder stays agnostic.
  // The conversation may not exist yet on the first turn (new conversation), so treat
  // a not-found error as "no replacementsId" — workflows will receive undefined and handle it.
  let replacementsId: string | undefined;
  if (context.conversationId) {
    try {
      const conversationClient = await conversations.getScopedClient({ request: context.request });
      const conversation = await conversationClient.get(context.conversationId);
      replacementsId = conversation.replacements_id;
    } catch (err) {
      if (!isConversationNotFoundError(err)) {
        throw err;
      }
      // New conversation — no replacementsId yet; workflow will produce one.
    }
  }

  let inferenceConfig: Record<string, unknown> = {
    ...(replacementsId ? { replacementsId } : {}),
  };

  for (const workflowId of workflowIds) {
    const result = await executeWorkflow({
      workflowId,
      workflowParams: {
        replacements_id: replacementsId,
      },
      request: context.request,
      spaceId,
      workflowApi,
      waitForCompletion: true,
      abortSignal: context.abortSignal,
      completionTimeoutSec,
    });

    if (!result.success) {
      throw createWorkflowExecutionError(result.error, { workflow: workflowId });
    }

    const execution = result.execution;
    if (execution.status === ExecutionStatus.FAILED) {
      const workflowName = execution.workflow_name ?? execution.workflow_id;
      const errorMessage = execution.error_message ?? `Workflow "${workflowName}" failed`;
      throw createWorkflowExecutionError(errorMessage, { workflow: workflowName });
    }

    logger.debug(
      `BeforeInference workflow finished: ${execution.workflow_id} (${execution.execution_id})`
    );

    const output = execution.output;
    if (typeof output === 'object' && output !== null && !Array.isArray(output)) {
      inferenceConfig = mergeConfigs(inferenceConfig, output);
    }
  }

  if (Object.keys(inferenceConfig).length === 0) {
    return;
  }

  return { inferenceConfig };
}

async function isBeforeInferenceWorkflowsEnabled(
  uiSettingsClient: IUiSettingsClient
): Promise<boolean> {
  const experimentalFeaturesEnabled =
    (await uiSettingsClient.get<boolean>(AGENT_BUILDER_EXPERIMENTAL_FEATURES_SETTING_ID)) ?? false;
  const workflowsUiEnabled =
    (await uiSettingsClient.get<boolean>(WORKFLOWS_UI_SETTING_ID)) ?? false;
  return workflowsUiEnabled && experimentalFeaturesEnabled;
}

async function getBeforeInferenceWorkflowIds(
  context: BeforeInferenceHookContext,
  agents: InternalStartServices['agents']
): Promise<string[]> {
  if (!context.agentId) {
    return [];
  }
  const registry = await agents.getRegistry({ request: context.request });
  const agent = await registry.get(context.agentId);
  if (!agent) {
    return [];
  }
  return agent.configuration?.lifecycle_workflows?.beforeInference ?? [];
}

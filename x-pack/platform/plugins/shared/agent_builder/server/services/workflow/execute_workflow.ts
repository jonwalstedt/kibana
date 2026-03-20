/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { KibanaRequest } from '@kbn/core-http-server';
import { safeJsonStringify } from '@kbn/std';
import { ExecutionStatus as WorkflowExecutionStatus } from '@kbn/workflows/types/v1';
import type { WorkflowsServerPluginSetup } from '@kbn/workflows-management-plugin/server';
import { ElasticGenAIAttributes, withActiveInferenceSpan } from '@kbn/inference-tracing';
import {
  getExecutionState,
  type WorkflowExecutionState,
} from '@kbn/agent-builder-genai-utils/tools/utils/workflows';
import type { WorkflowExecutionResult } from './types';

type WorkflowApi = WorkflowsServerPluginSetup['management'];

const DEFAULT_COMPLETION_TIMEOUT_SEC = 120;
const INITIAL_WAIT_MS = 1_000;
const CHECK_INTERVAL_MS = 2_500;

const finalStatuses = [WorkflowExecutionStatus.COMPLETED, WorkflowExecutionStatus.FAILED];

export interface ExecuteWorkflowParams {
  workflowId: string;
  workflowParams: Record<string, unknown>;
  request: KibanaRequest;
  spaceId: string;
  workflowApi: WorkflowApi;
  waitForCompletion?: boolean;
  completionTimeoutSec?: number;
  metadata?: Record<string, unknown>;
  /**
   * Optional abort signal. When fired, the polling loop exits early and returns a
   * failure result. The underlying workflow execution may continue running in the
   * workflow engine — cancellation of the engine execution is not currently supported.
   */
  abortSignal?: AbortSignal;
}

export const executeWorkflow = async ({
  workflowId,
  workflowParams,
  request,
  spaceId,
  workflowApi,
  waitForCompletion = true,
  completionTimeoutSec = DEFAULT_COMPLETION_TIMEOUT_SEC,
  metadata,
  abortSignal,
}: ExecuteWorkflowParams): Promise<WorkflowExecutionResult> => {
  const workflow = await workflowApi.getWorkflow(workflowId, spaceId);

  if (!workflow) {
    return { success: false, error: `Workflow '${workflowId}' not found.` };
  }
  if (!workflow.enabled) {
    return {
      success: false,
      error: `Workflow '${workflowId}' is disabled and cannot be executed.`,
    };
  }
  if (!workflow.valid) {
    return {
      success: false,
      error: `Workflow '${workflowId}' has validation errors and cannot be executed.`,
    };
  }
  const definition = workflow.definition;
  if (!definition) {
    return {
      success: false,
      error: `Workflow '${workflowId}' has no definition and cannot be executed.`,
    };
  }

  const workflowForExecution = {
    id: workflow.id,
    name: workflow.name,
    enabled: workflow.enabled,
    definition,
    yaml: workflow.yaml,
  };

  return withActiveInferenceSpan(
    `Workflow: ${workflow.name}`,
    {
      attributes: {
        [ElasticGenAIAttributes.InferenceSpanKind]: 'CHAIN',
        'elastic.workflow.id': workflow.id,
        'elastic.workflow.name': workflow.name,
        'input.value': safeJsonStringify(workflowParams) ?? '{}',
      },
    },
    async (span) => {
      let executionId: string;
      try {
        executionId = await workflowApi.runWorkflow(
          workflowForExecution,
          spaceId,
          workflowParams,
          request,
          undefined,
          metadata
        );
      } catch (err) {
        // The workflow engine can throw synchronously from AbortSignal event listeners
        // (e.g. TimeoutAbortedError from persistence_loop), which escapes a plain await.
        // Catch here so the error surfaces as a { success: false } result rather than
        // an unhandled rejection that crashes the Kibana process.
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }

      span?.setAttribute('elastic.workflow.execution_id', executionId);

      const waitLimit = Date.now() + completionTimeoutSec * 1000;
      await waitMs(INITIAL_WAIT_MS);

      let execution: WorkflowExecutionState | null | undefined;
      do {
        if (abortSignal?.aborted) {
          const result: WorkflowExecutionResult = {
            success: false,
            error: `Workflow '${workflowId}' polling aborted by caller.`,
          };
          span?.setAttribute('output.value', safeJsonStringify(result) ?? 'unknown');
          return result;
        }

        try {
          execution = await getExecutionState({ executionId, spaceId, workflowApi });

          const shouldReturn = waitForCompletion
            ? execution && finalStatuses.includes(execution.status)
            : execution;

          if (shouldReturn && execution) {
            const result: WorkflowExecutionResult = { success: true, execution };
            span?.setAttribute('output.value', safeJsonStringify(result) ?? 'unknown');
            return result;
          }
        } catch (e) {
          // trap - we just keep waiting until timeout
        }

        await waitMs(CHECK_INTERVAL_MS);
      } while (Date.now() < waitLimit);

      if (execution) {
        const result: WorkflowExecutionResult = { success: true, execution };
        span?.setAttribute('output.value', safeJsonStringify(result) ?? 'unknown');
        return result;
      }

      const result: WorkflowExecutionResult = {
        success: false,
        error: `Workflow '${workflowId}' executed but execution not found after ${completionTimeoutSec}s.`,
      };
      span?.setAttribute('output.value', safeJsonStringify(result) ?? 'unknown');
      return result;
    }
  );
};

const waitMs = (durationMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { AgentBuilderErrorCode, createConversationNotFoundError } from '@kbn/agent-builder-common';
import { httpServerMock } from '@kbn/core-http-server-mocks';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { savedObjectsServiceMock } from '@kbn/core-saved-objects-server-mocks';
import { uiSettingsServiceMock } from '@kbn/core-ui-settings-server-mocks';
import { AGENT_BUILDER_EXPERIMENTAL_FEATURES_SETTING_ID } from '@kbn/management-settings-ids';
import { ExecutionStatus, WORKFLOWS_UI_SETTING_ID } from '@kbn/workflows';
import type { JsonValue } from '@kbn/utility-types';
import { runBeforeInferenceWorkflows } from './run_before_inference_workflows';
import { executeWorkflow } from '../../services/workflow/execute_workflow';
import type { WorkflowExecutionResult } from '../../services/workflow/types';
import { getCurrentSpaceId } from '../../utils/spaces';

jest.mock('../../services/workflow/execute_workflow', () => ({
  executeWorkflow: jest.fn(),
}));

jest.mock('../../utils/spaces', () => ({
  getCurrentSpaceId: jest.fn(() => 'default'),
}));

const executeWorkflowMock = jest.mocked(executeWorkflow);
const getCurrentSpaceIdMock = jest.mocked(getCurrentSpaceId);

type RunBeforeInferenceWorkflowsParams = Parameters<typeof runBeforeInferenceWorkflows>[0];
type WorkflowApi = RunBeforeInferenceWorkflowsParams['workflowApi'];
type GetInternalServices = RunBeforeInferenceWorkflowsParams['getInternalServices'];

describe('runBeforeInferenceWorkflows', () => {
  const request = httpServerMock.createKibanaRequest();
  const logger = loggingSystemMock.createLogger();

  const createContext = (overrides: Record<string, unknown> = {}) => ({
    request,
    agentId: 'agent-1',
    ...overrides,
  });

  const createDeps = (
    agentConfig: Record<string, unknown> = {
      lifecycle_workflows: { beforeInference: ['wf-anon-1'] },
    },
    conversationReplacementsId?: string
  ) => {
    const savedObjects = savedObjectsServiceMock.createStartContract();
    const uiSettings = uiSettingsServiceMock.createStartContract();
    const uiSettingsClient = uiSettingsServiceMock.createClient();
    uiSettingsClient.get.mockResolvedValue(true);
    const soClient = savedObjects.createInternalRepository();
    savedObjects.getScopedClient.mockReturnValue(soClient);
    uiSettings.asScopedToClient.mockReturnValue(uiSettingsClient);

    const registry = {
      get: jest.fn().mockResolvedValue({
        id: 'agent-1',
        configuration: agentConfig,
      }),
    };

    const conversationClient = {
      get: jest.fn().mockResolvedValue({ replacements_id: conversationReplacementsId }),
    };
    const conversations = {
      getScopedClient: jest.fn().mockResolvedValue(conversationClient),
    };

    return {
      workflowApi: {} as WorkflowApi,
      getInternalServices: jest.fn(() => ({
        agents: {
          getRegistry: jest.fn().mockResolvedValue(registry),
        },
        spaces: {},
        uiSettings,
        savedObjects,
        conversations,
      })) as unknown as GetInternalServices,
      registry,
      uiSettingsClient,
      conversationClient,
    };
  };

  const makeCompletedExecution = (output: unknown): WorkflowExecutionResult => ({
    success: true,
    execution: {
      execution_id: 'exec-1',
      status: ExecutionStatus.COMPLETED,
      workflow_id: 'wf-anon-1',
      started_at: '2026-01-01T00:00:00.000Z',
      output: output as JsonValue,
    },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    getCurrentSpaceIdMock.mockReturnValue('default');
  });

  // ── Feature flag gate ──────────────────────────────────────────────────────

  it('returns undefined when experimental features UI setting is disabled', async () => {
    const context = createContext();
    const { workflowApi, getInternalServices, uiSettingsClient } = createDeps();
    uiSettingsClient.get.mockImplementation(async (key: string) => {
      if (key === AGENT_BUILDER_EXPERIMENTAL_FEATURES_SETTING_ID) return false;
      return true;
    });

    const result = await runBeforeInferenceWorkflows({
      context,
      workflowApi,
      getInternalServices,
      logger,
    });

    expect(result).toBeUndefined();
    expect(executeWorkflowMock).not.toHaveBeenCalled();
  });

  it('returns undefined when workflows UI setting is disabled', async () => {
    const context = createContext();
    const { workflowApi, getInternalServices, uiSettingsClient } = createDeps();
    uiSettingsClient.get.mockImplementation(async (key: string) => {
      if (key === WORKFLOWS_UI_SETTING_ID) return false;
      return true;
    });

    const result = await runBeforeInferenceWorkflows({
      context,
      workflowApi,
      getInternalServices,
      logger,
    });

    expect(result).toBeUndefined();
    expect(executeWorkflowMock).not.toHaveBeenCalled();
  });

  // ── No workflows configured ───────────────────────────────────────────────

  it('returns undefined when no workflow IDs are configured', async () => {
    const context = createContext();
    const { workflowApi, getInternalServices } = createDeps({
      lifecycle_workflows: { beforeInference: [] },
    });

    const result = await runBeforeInferenceWorkflows({
      context,
      workflowApi,
      getInternalServices,
      logger,
    });

    expect(result).toBeUndefined();
    expect(executeWorkflowMock).not.toHaveBeenCalled();
  });

  it('returns undefined when agentId is absent', async () => {
    const context = createContext({ agentId: undefined });
    const { workflowApi, getInternalServices } = createDeps();

    const result = await runBeforeInferenceWorkflows({
      context,
      workflowApi,
      getInternalServices,
      logger,
    });

    expect(result).toBeUndefined();
    expect(executeWorkflowMock).not.toHaveBeenCalled();
  });

  it('returns undefined when agent is not found in registry', async () => {
    const context = createContext();
    const { workflowApi, getInternalServices, registry } = createDeps();
    registry.get.mockResolvedValue(null);

    const result = await runBeforeInferenceWorkflows({
      context,
      workflowApi,
      getInternalServices,
      logger,
    });

    expect(result).toBeUndefined();
    expect(executeWorkflowMock).not.toHaveBeenCalled();
  });

  // ── Workflow ID resolution ────────────────────────────────────────────────

  it('uses lifecycle_workflows.beforeInference when present', async () => {
    const context = createContext();
    const { workflowApi, getInternalServices } = createDeps({
      lifecycle_workflows: { beforeInference: ['wf-new'] },
    });
    executeWorkflowMock.mockResolvedValue(makeCompletedExecution({ rules: [] }));

    await runBeforeInferenceWorkflows({ context, workflowApi, getInternalServices, logger });

    expect(executeWorkflowMock).toHaveBeenCalledTimes(1);
    expect(executeWorkflowMock).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-new' })
    );
  });

  // ── Workflow output pass-through ──────────────────────────────────────────

  it('passes workflow output directly as inferenceConfig', async () => {
    const context = createContext();
    const { workflowApi, getInternalServices } = createDeps();
    const output = { additionalRules: [{ type: 'RegExp', pattern: '\\d+', entityClass: 'NUM' }] };
    executeWorkflowMock.mockResolvedValue(makeCompletedExecution(output));

    const result = await runBeforeInferenceWorkflows({
      context,
      workflowApi,
      getInternalServices,
      logger,
    });

    expect(result).toEqual({ inferenceConfig: output });
  });

  it('merges outputs from multiple chained workflows (arrays concatenated)', async () => {
    const context = createContext();
    const { workflowApi, getInternalServices } = createDeps({
      lifecycle_workflows: { beforeInference: ['wf-1', 'wf-2'] },
    });

    const rules1 = [{ type: 'RegExp', pattern: '\\d+', entityClass: 'NUM' }];
    const rules2 = [{ type: 'RegExp', pattern: '[A-Z]+', entityClass: 'UPPER' }];

    executeWorkflowMock
      .mockResolvedValueOnce({
        success: true,
        execution: {
          execution_id: 'exec-1',
          status: ExecutionStatus.COMPLETED,
          workflow_id: 'wf-1',
          started_at: '2026-01-01T00:00:00.000Z',
          output: { additionalRules: rules1 },
        },
      })
      .mockResolvedValueOnce({
        success: true,
        execution: {
          execution_id: 'exec-2',
          status: ExecutionStatus.COMPLETED,
          workflow_id: 'wf-2',
          started_at: '2026-01-01T00:00:00.000Z',
          output: { additionalRules: rules2 },
        },
      });

    const result = await runBeforeInferenceWorkflows({
      context,
      workflowApi,
      getInternalServices,
      logger,
    });

    expect(result).toEqual({
      inferenceConfig: { additionalRules: [...rules1, ...rules2] },
    });
  });

  it('last-writer-wins for scalar values across chained workflows', async () => {
    const context = createContext();
    const { workflowApi, getInternalServices } = createDeps({
      lifecycle_workflows: { beforeInference: ['wf-1', 'wf-2'] },
    });

    executeWorkflowMock
      .mockResolvedValueOnce({
        success: true,
        execution: {
          execution_id: 'exec-1',
          status: ExecutionStatus.COMPLETED,
          workflow_id: 'wf-1',
          started_at: '2026-01-01T00:00:00.000Z',
          output: { keepTokenized: false },
        },
      })
      .mockResolvedValueOnce({
        success: true,
        execution: {
          execution_id: 'exec-2',
          status: ExecutionStatus.COMPLETED,
          workflow_id: 'wf-2',
          started_at: '2026-01-01T00:00:00.000Z',
          output: { keepTokenized: true },
        },
      });

    const result = await runBeforeInferenceWorkflows({
      context,
      workflowApi,
      getInternalServices,
      logger,
    });

    expect(result).toEqual({ inferenceConfig: { keepTokenized: true } });
  });

  it('skips non-object workflow output', async () => {
    const context = createContext();
    const { workflowApi, getInternalServices } = createDeps();
    executeWorkflowMock.mockResolvedValue(makeCompletedExecution('a plain string'));

    const result = await runBeforeInferenceWorkflows({
      context,
      workflowApi,
      getInternalServices,
      logger,
    });

    expect(result).toBeUndefined();
  });

  it('skips array workflow output (not unwrapped)', async () => {
    const context = createContext();
    const { workflowApi, getInternalServices } = createDeps();
    executeWorkflowMock.mockResolvedValue(makeCompletedExecution([{ additionalRules: [] }]));

    const result = await runBeforeInferenceWorkflows({
      context,
      workflowApi,
      getInternalServices,
      logger,
    });

    expect(result).toBeUndefined();
  });

  it('returns undefined when workflow output is an empty object', async () => {
    const context = createContext();
    const { workflowApi, getInternalServices } = createDeps();
    executeWorkflowMock.mockResolvedValue(makeCompletedExecution({}));

    const result = await runBeforeInferenceWorkflows({
      context,
      workflowApi,
      getInternalServices,
      logger,
    });

    expect(result).toBeUndefined();
  });

  // ── replacementsId from conversation ─────────────────────────────────────

  it('seeds replacementsId from conversation and passes it to workflow params', async () => {
    const context = createContext({ conversationId: 'conv-1' });
    const { workflowApi, getInternalServices } = createDeps(
      { lifecycle_workflows: { beforeInference: ['wf-anon-1'] } },
      'repl-from-conv'
    );
    executeWorkflowMock.mockResolvedValue(makeCompletedExecution({ additionalRules: [] }));

    await runBeforeInferenceWorkflows({ context, workflowApi, getInternalServices, logger });

    expect(executeWorkflowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowParams: { replacements_id: 'repl-from-conv' },
      })
    );
  });

  it('includes replacementsId from conversation in inferenceConfig', async () => {
    const context = createContext({ conversationId: 'conv-1' });
    const { workflowApi, getInternalServices } = createDeps(
      { lifecycle_workflows: { beforeInference: ['wf-anon-1'] } },
      'repl-from-conv'
    );
    executeWorkflowMock.mockResolvedValue(makeCompletedExecution({ additionalRules: [] }));

    const result = await runBeforeInferenceWorkflows({
      context,
      workflowApi,
      getInternalServices,
      logger,
    });

    expect(result).toEqual({
      inferenceConfig: { replacementsId: 'repl-from-conv', additionalRules: [] },
    });
  });

  it('continues without replacementsId when conversation does not exist yet (new conversation)', async () => {
    const context = createContext({ conversationId: 'new-conv-id' });
    const { workflowApi, getInternalServices, conversationClient } = createDeps({
      lifecycle_workflows: { beforeInference: ['wf-anon-1'] },
    });
    conversationClient.get.mockRejectedValue(
      createConversationNotFoundError({ conversationId: 'new-conv-id' })
    );
    executeWorkflowMock.mockResolvedValue(makeCompletedExecution({ effectiveFieldPolicy: {} }));

    const result = await runBeforeInferenceWorkflows({
      context,
      workflowApi,
      getInternalServices,
      logger,
    });

    // Workflow should still run with no replacements_id
    expect(executeWorkflowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowParams: { replacements_id: undefined },
      })
    );
    // And inferenceConfig should come back from the workflow
    expect(result).toEqual({ inferenceConfig: { effectiveFieldPolicy: {} } });
  });

  it('rethrows non-NotFound errors when fetching conversation', async () => {
    const context = createContext({ conversationId: 'conv-1' });
    const { workflowApi, getInternalServices, conversationClient } = createDeps({
      lifecycle_workflows: { beforeInference: ['wf-anon-1'] },
    });
    const internalError = new Error('DB connection failed');
    conversationClient.get.mockRejectedValue(internalError);

    await expect(
      runBeforeInferenceWorkflows({ context, workflowApi, getInternalServices, logger })
    ).rejects.toThrow('DB connection failed');
    expect(executeWorkflowMock).not.toHaveBeenCalled();
  });

  it('does not fetch conversation when conversationId is absent', async () => {
    const context = createContext();
    const { workflowApi, getInternalServices, conversationClient } = createDeps(
      { lifecycle_workflows: { beforeInference: ['wf-anon-1'] } },
      'repl-id'
    );
    executeWorkflowMock.mockResolvedValue(makeCompletedExecution({ additionalRules: [] }));

    await runBeforeInferenceWorkflows({ context, workflowApi, getInternalServices, logger });

    expect(conversationClient.get).not.toHaveBeenCalled();
  });

  // ── Error handling ────────────────────────────────────────────────────────

  it('throws workflowExecutionFailed when workflow execution request fails', async () => {
    const context = createContext();
    const { workflowApi, getInternalServices } = createDeps();
    executeWorkflowMock.mockResolvedValue({
      success: false,
      error: 'Workflow unavailable',
    });

    await expect(
      runBeforeInferenceWorkflows({ context, workflowApi, getInternalServices, logger })
    ).rejects.toMatchObject({
      code: AgentBuilderErrorCode.workflowExecutionFailed,
      message: 'Workflow unavailable',
      meta: { workflow: 'wf-anon-1' },
    });
  });

  it('throws workflowExecutionFailed when workflow engine reports FAILED status', async () => {
    const context = createContext();
    const { workflowApi, getInternalServices } = createDeps();
    executeWorkflowMock.mockResolvedValue({
      success: true,
      execution: {
        execution_id: 'exec-fail',
        status: ExecutionStatus.FAILED,
        workflow_id: 'wf-anon-1',
        workflow_name: 'Anon Workflow',
        started_at: '2026-01-01T00:00:00.000Z',
        error_message: 'Profile lookup failed',
      },
    });

    await expect(
      runBeforeInferenceWorkflows({ context, workflowApi, getInternalServices, logger })
    ).rejects.toMatchObject({
      code: AgentBuilderErrorCode.workflowExecutionFailed,
      message: 'Profile lookup failed',
      meta: { workflow: 'Anon Workflow' },
    });
  });

  it('throws workflowExecutionFailed with fallback message when FAILED has no error_message', async () => {
    const context = createContext();
    const { workflowApi, getInternalServices } = createDeps();
    executeWorkflowMock.mockResolvedValue({
      success: true,
      execution: {
        execution_id: 'exec-fail-no-msg',
        status: ExecutionStatus.FAILED,
        workflow_id: 'wf-anon-1',
        started_at: '2026-01-01T00:00:00.000Z',
      },
    });

    await expect(
      runBeforeInferenceWorkflows({ context, workflowApi, getInternalServices, logger })
    ).rejects.toMatchObject({
      code: AgentBuilderErrorCode.workflowExecutionFailed,
      message: 'Workflow "wf-anon-1" failed',
      meta: { workflow: 'wf-anon-1' },
    });
  });
});

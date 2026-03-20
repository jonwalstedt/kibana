/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { AgentBuilderErrorCode } from '@kbn/agent-builder-common';
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
    }
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

    return {
      workflowApi: {} as WorkflowApi,
      getInternalServices: jest.fn(() => ({
        agents: {
          getRegistry: jest.fn().mockResolvedValue(registry),
        },
        spaces: {},
        uiSettings,
        savedObjects,
      })) as unknown as GetInternalServices,
      registry,
      uiSettingsClient,
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

  // ── replacementsId threading ──────────────────────────────────────────────

  it('passes replacementsId from context to workflow params', async () => {
    const context = createContext({ conversationId: 'conv-1', replacementsId: 'repl-from-conv' });
    const { workflowApi, getInternalServices } = createDeps({
      lifecycle_workflows: { beforeInference: ['wf-anon-1'] },
    });
    executeWorkflowMock.mockResolvedValue(makeCompletedExecution({ additionalRules: [] }));

    await runBeforeInferenceWorkflows({ context, workflowApi, getInternalServices, logger });

    expect(executeWorkflowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowParams: { replacements_id: 'repl-from-conv' },
      })
    );
  });

  it('includes replacementsId from context in inferenceConfig', async () => {
    const context = createContext({ conversationId: 'conv-1', replacementsId: 'repl-from-conv' });
    const { workflowApi, getInternalServices } = createDeps({
      lifecycle_workflows: { beforeInference: ['wf-anon-1'] },
    });
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

  it('runs workflow without replacementsId on first turn (new conversation)', async () => {
    const context = createContext({ conversationId: 'new-conv-id' });
    const { workflowApi, getInternalServices } = createDeps({
      lifecycle_workflows: { beforeInference: ['wf-anon-1'] },
    });
    executeWorkflowMock.mockResolvedValue(makeCompletedExecution({ effectiveFieldPolicy: {} }));

    const result = await runBeforeInferenceWorkflows({
      context,
      workflowApi,
      getInternalServices,
      logger,
    });

    expect(executeWorkflowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowParams: { replacements_id: undefined },
      })
    );
    expect(result).toEqual({ inferenceConfig: { effectiveFieldPolicy: {} } });
  });

  it('maintains the same replacementsId across conversation turns', async () => {
    // Simulates the anonymize_fields step: generates a UUID on turn 1 when none is
    // provided, and returns the same UUID on subsequent turns when one is provided.
    // This mirrors the real step handler: input.replacements_id ?? (toolDeanonymization ? uuidv4() : undefined)
    const agentConfig = { lifecycle_workflows: { beforeInference: ['wf-anon-1'] } };
    const stepOutput = { effectiveFieldPolicy: {}, toolDeanonymization: { mode: 'all' } };

    // ── Turn 1: new conversation, no replacementsId ──────────────────────────
    executeWorkflowMock.mockImplementationOnce(({ workflowParams }) => {
      // Step generates a new UUID because none was provided — mirrors the real step
      const generatedId = workflowParams.replacements_id ?? 'uuid-generated-by-step';
      return Promise.resolve(
        makeCompletedExecution({ ...stepOutput, replacementsId: generatedId })
      );
    });

    const turn1Context = createContext({ conversationId: 'conv-1' }); // no replacementsId
    const { workflowApi, getInternalServices } = createDeps(agentConfig);

    const turn1Result = await runBeforeInferenceWorkflows({
      context: turn1Context,
      workflowApi,
      getInternalServices,
      logger,
    });

    // Turn 1 workflow received no replacements_id
    expect(executeWorkflowMock).toHaveBeenCalledWith(
      expect.objectContaining({ workflowParams: { replacements_id: undefined } })
    );

    const idFromTurn1 = (turn1Result as any)?.inferenceConfig?.replacementsId;
    expect(idFromTurn1).toBe('uuid-generated-by-step');

    jest.clearAllMocks();

    // ── Turn 2: same conversation, replacementsId from turn 1 ────────────────
    executeWorkflowMock.mockImplementationOnce(({ workflowParams }) => {
      // Step reuses the provided ID — mirrors the real step
      const reusedId = workflowParams.replacements_id;
      return Promise.resolve(makeCompletedExecution({ ...stepOutput, replacementsId: reusedId }));
    });

    // Caller now threads the ID that was persisted after turn 1
    const turn2Context = createContext({
      conversationId: 'conv-1',
      replacementsId: idFromTurn1,
    });
    const { workflowApi: workflowApi2, getInternalServices: getInternalServices2 } =
      createDeps(agentConfig);

    const turn2Result = await runBeforeInferenceWorkflows({
      context: turn2Context,
      workflowApi: workflowApi2,
      getInternalServices: getInternalServices2,
      logger,
    });

    // Turn 2 workflow received the same ID that was generated in turn 1
    expect(executeWorkflowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowParams: { replacements_id: 'uuid-generated-by-step' },
      })
    );

    const idFromTurn2 = (turn2Result as any)?.inferenceConfig?.replacementsId;

    // Both turns share the same replacementsId — tokens from turn 1 remain valid in turn 2
    expect(idFromTurn2).toBe(idFromTurn1);
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

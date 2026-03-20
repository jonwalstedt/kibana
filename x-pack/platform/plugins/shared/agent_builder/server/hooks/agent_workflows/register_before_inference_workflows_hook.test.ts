/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { HookLifecycle, HookExecutionMode } from '@kbn/agent-builder-server';
import { httpServerMock } from '@kbn/core-http-server-mocks';
import { registerBeforeInferenceWorkflowsHook } from './register_before_inference_workflows_hook';
import { runBeforeInferenceWorkflows } from './run_before_inference_workflows';
import type { RegisterBeforeInferenceWorkflowsHookDeps } from './register_before_inference_workflows_hook';
import type { InternalSetupServices } from '../../services';

jest.mock('./run_before_inference_workflows', () => ({
  runBeforeInferenceWorkflows: jest.fn(),
}));

const runBeforeInferenceWorkflowsMock = jest.mocked(runBeforeInferenceWorkflows);

describe('registerBeforeInferenceWorkflowsHook', () => {
  const logger = loggingSystemMock.createLogger();

  const createServiceSetups = (): InternalSetupServices =>
    ({
      hooks: {
        register: jest.fn(),
      },
    } as unknown as InternalSetupServices);

  const createDeps = (
    overrides: Partial<RegisterBeforeInferenceWorkflowsHookDeps> = {}
  ): RegisterBeforeInferenceWorkflowsHookDeps => ({
    workflowsManagement: {
      management:
        {} as RegisterBeforeInferenceWorkflowsHookDeps['workflowsManagement']['management'],
    } as NonNullable<RegisterBeforeInferenceWorkflowsHookDeps['workflowsManagement']>,
    logger,
    getInternalServices: jest.fn(),
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('skips registration when workflowsManagement is not provided', () => {
    const serviceSetups = createServiceSetups();
    const deps = createDeps({ workflowsManagement: undefined });

    registerBeforeInferenceWorkflowsHook(serviceSetups, deps);

    expect(serviceSetups.hooks.register).not.toHaveBeenCalled();
  });

  it('registers a beforeInference blocking hook when workflowsManagement is available', () => {
    const serviceSetups = createServiceSetups();
    const deps = createDeps();

    registerBeforeInferenceWorkflowsHook(serviceSetups, deps);

    expect(serviceSetups.hooks.register).toHaveBeenCalledTimes(1);
    expect(serviceSetups.hooks.register).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'before-inference-workflows',
        hooks: expect.objectContaining({
          [HookLifecycle.beforeInference]: expect.objectContaining({
            mode: HookExecutionMode.blocking,
            handler: expect.any(Function),
          }),
        }),
      })
    );
  });

  describe('hook handler', () => {
    const getHandler = (serviceSetups: InternalSetupServices) => {
      const registerMock = serviceSetups.hooks.register as jest.Mock;
      return registerMock.mock.calls[0][0].hooks[HookLifecycle.beforeInference].handler;
    };

    const createContext = () => ({
      request: httpServerMock.createKibanaRequest(),
      agentId: 'agent-1',
      replacementsId: undefined,
      abortSignal: new AbortController().signal,
    });

    it('returns the result from runBeforeInferenceWorkflows on success', async () => {
      const serviceSetups = createServiceSetups();
      const deps = createDeps();
      const expectedResult = { inferenceConfig: { additionalRules: [] } };
      runBeforeInferenceWorkflowsMock.mockResolvedValue(expectedResult);

      registerBeforeInferenceWorkflowsHook(serviceSetups, deps);
      const handler = getHandler(serviceSetups);
      const context = createContext();

      const result = await handler(context);

      expect(result).toEqual(expectedResult);
      expect(runBeforeInferenceWorkflowsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          context,
          workflowApi: deps.workflowsManagement!.management,
          getInternalServices: deps.getInternalServices,
          completionTimeoutSec: 30,
        })
      );
    });

    it('returns undefined and logs error when runBeforeInferenceWorkflows throws (fail-open)', async () => {
      const serviceSetups = createServiceSetups();
      const deps = createDeps();
      runBeforeInferenceWorkflowsMock.mockRejectedValue(new Error('workflow failed'));

      registerBeforeInferenceWorkflowsHook(serviceSetups, deps);
      const handler = getHandler(serviceSetups);
      const context = createContext();

      const result = await handler(context);

      expect(result).toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('workflow failed'));
    });

    it('logs non-Error throws as strings', async () => {
      const serviceSetups = createServiceSetups();
      const deps = createDeps();
      runBeforeInferenceWorkflowsMock.mockRejectedValue('string error');

      registerBeforeInferenceWorkflowsHook(serviceSetups, deps);
      const handler = getHandler(serviceSetups);

      await handler(createContext());

      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('string error'));
    });
  });
});

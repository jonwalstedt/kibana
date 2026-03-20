/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { httpServerMock } from '@kbn/core-http-server-mocks';
import { HookLifecycle, HookExecutionMode } from '@kbn/agent-builder-server';
import { ToolResultType } from '@kbn/agent-builder-common';
import { registerToolDeanonymizationHooks } from './register_tool_deanonymization_hooks';
import type { RegisterToolDeanonymizationHooksDeps } from './register_tool_deanonymization_hooks';
import type { InternalSetupServices } from '../../services';

const HOST_TOKEN = 'HOST_NAME_abc123';
const HOST_ORIGINAL = 'frizzy-reach.info';

describe('registerToolDeanonymizationHooks', () => {
  const logger = loggingSystemMock.createLogger();

  const tokenToOriginalMap = Object.fromEntries([[HOST_TOKEN, HOST_ORIGINAL]]);

  const createServiceSetups = (): InternalSetupServices =>
    ({
      hooks: {
        register: jest.fn(),
      },
    } as unknown as InternalSetupServices);

  const createDeps = (
    overrides: Partial<RegisterToolDeanonymizationHooksDeps> = {}
  ): RegisterToolDeanonymizationHooksDeps => ({
    logger,
    getInferenceStart: jest.fn().mockReturnValue({
      getTokenToOriginalMap: jest.fn().mockResolvedValue(tokenToOriginalMap),
    }),
    getSpaces: jest.fn().mockReturnValue(undefined),
    ...overrides,
  });

  const createBeforeContext = (overrides: Record<string, unknown> = {}) => ({
    request: httpServerMock.createKibanaRequest(),
    toolId: 'security.entity_analytics.risk_score',
    toolCallId: 'call-1',
    toolParams: { entityId: HOST_TOKEN } as Record<string, unknown>,
    source: 'agent' as const,
    abortSignal: new AbortController().signal,
    inferenceConfig: {
      replacementsId: 'replacements-abc',
      toolDeanonymization: {
        mode: 'allowlist',
        toolIds: ['security.entity_analytics.risk_score'],
      },
    } as Record<string, unknown>,
    ...overrides,
  });

  const createAfterContext = (overrides: Record<string, unknown> = {}) => ({
    ...createBeforeContext(),
    toolReturn: {
      results: [
        {
          type: ToolResultType.other,
          data: `Risk for ${HOST_ORIGINAL}: 80`,
          tool_result_id: 'r1',
        },
      ],
    },
    toolHandlerContext: {} as any,
    ...overrides,
  });

  const getBeforeHandler = (serviceSetups: InternalSetupServices) => {
    const registerMock = serviceSetups.hooks.register as jest.Mock;
    return registerMock.mock.calls[0][0].hooks[HookLifecycle.beforeToolCall].handler;
  };

  const getAfterHandler = (serviceSetups: InternalSetupServices) => {
    const registerMock = serviceSetups.hooks.register as jest.Mock;
    return registerMock.mock.calls[0][0].hooks[HookLifecycle.afterToolCall].handler;
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('registers both beforeToolCall and afterToolCall blocking hooks', () => {
    const serviceSetups = createServiceSetups();
    registerToolDeanonymizationHooks(serviceSetups, createDeps());

    expect(serviceSetups.hooks.register).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'tool-deanonymization',
        hooks: expect.objectContaining({
          [HookLifecycle.beforeToolCall]: expect.objectContaining({
            mode: HookExecutionMode.blocking,
          }),
          [HookLifecycle.afterToolCall]: expect.objectContaining({
            mode: HookExecutionMode.blocking,
          }),
        }),
      })
    );
  });

  describe('beforeToolCall handler', () => {
    it('deanonymizes toolParams when policy allows the tool', async () => {
      const serviceSetups = createServiceSetups();
      const deps = createDeps();
      registerToolDeanonymizationHooks(serviceSetups, deps);
      const handler = getBeforeHandler(serviceSetups);

      const result = await handler(createBeforeContext());

      expect(result).toEqual({ toolParams: { entityId: HOST_ORIGINAL } });
    });

    it('returns undefined when no inferenceConfig', async () => {
      const serviceSetups = createServiceSetups();
      registerToolDeanonymizationHooks(serviceSetups, createDeps());
      const handler = getBeforeHandler(serviceSetups);

      const result = await handler(createBeforeContext({ inferenceConfig: undefined }));

      expect(result).toBeUndefined();
    });

    it('returns undefined when toolDeanonymization policy is absent', async () => {
      const serviceSetups = createServiceSetups();
      registerToolDeanonymizationHooks(serviceSetups, createDeps());
      const handler = getBeforeHandler(serviceSetups);

      const result = await handler(
        createBeforeContext({
          inferenceConfig: { replacementsId: 'replacements-abc' },
        })
      );

      expect(result).toBeUndefined();
    });

    it('returns undefined when tool is not in allowlist', async () => {
      const serviceSetups = createServiceSetups();
      registerToolDeanonymizationHooks(serviceSetups, createDeps());
      const handler = getBeforeHandler(serviceSetups);

      const result = await handler(
        createBeforeContext({
          toolId: 'some.other.tool',
          inferenceConfig: {
            replacementsId: 'replacements-abc',
            toolDeanonymization: {
              mode: 'allowlist',
              toolIds: ['security.entity_analytics.risk_score'],
            },
          },
        })
      );

      expect(result).toBeUndefined();
    });

    it('returns undefined when mode is none', async () => {
      const serviceSetups = createServiceSetups();
      registerToolDeanonymizationHooks(serviceSetups, createDeps());
      const handler = getBeforeHandler(serviceSetups);

      const result = await handler(
        createBeforeContext({
          inferenceConfig: {
            replacementsId: 'replacements-abc',
            toolDeanonymization: { mode: 'none' },
          },
        })
      );

      expect(result).toBeUndefined();
    });

    it('returns undefined when tokenToOriginalMap is null (no replacements found)', async () => {
      const serviceSetups = createServiceSetups();
      const deps = createDeps({
        getInferenceStart: jest.fn().mockReturnValue({
          getTokenToOriginalMap: jest.fn().mockResolvedValue(null),
        }),
      });
      registerToolDeanonymizationHooks(serviceSetups, deps);
      const handler = getBeforeHandler(serviceSetups);

      const result = await handler(createBeforeContext());

      expect(result).toBeUndefined();
    });

    it('fails open and returns undefined when getTokenToOriginalMap throws', async () => {
      const serviceSetups = createServiceSetups();
      const deps = createDeps({
        getInferenceStart: jest.fn().mockReturnValue({
          getTokenToOriginalMap: jest.fn().mockRejectedValue(new Error('ES error')),
        }),
      });
      registerToolDeanonymizationHooks(serviceSetups, deps);
      const handler = getBeforeHandler(serviceSetups);

      const result = await handler(createBeforeContext());

      expect(result).toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('ES error'));
    });

    it('deanonymizes all tools when mode is all', async () => {
      const serviceSetups = createServiceSetups();
      registerToolDeanonymizationHooks(serviceSetups, createDeps());
      const handler = getBeforeHandler(serviceSetups);

      const result = await handler(
        createBeforeContext({
          toolId: 'any.tool',
          inferenceConfig: {
            replacementsId: 'replacements-abc',
            toolDeanonymization: { mode: 'all' },
          },
        })
      );

      expect(result).toEqual({ toolParams: { entityId: HOST_ORIGINAL } });
    });
  });

  describe('afterToolCall handler', () => {
    it('re-anonymizes toolReturn when policy allows the tool', async () => {
      const serviceSetups = createServiceSetups();
      registerToolDeanonymizationHooks(serviceSetups, createDeps());
      const handler = getAfterHandler(serviceSetups);

      const result = await handler(createAfterContext());

      expect(result?.toolReturn?.results?.[0].data).toBe(`Risk for ${HOST_TOKEN}: 80`);
    });

    it('returns undefined when no inferenceConfig', async () => {
      const serviceSetups = createServiceSetups();
      registerToolDeanonymizationHooks(serviceSetups, createDeps());
      const handler = getAfterHandler(serviceSetups);

      const result = await handler(createAfterContext({ inferenceConfig: undefined }));

      expect(result).toBeUndefined();
    });

    it('returns undefined when tool is not in allowlist', async () => {
      const serviceSetups = createServiceSetups();
      registerToolDeanonymizationHooks(serviceSetups, createDeps());
      const handler = getAfterHandler(serviceSetups);

      const result = await handler(
        createAfterContext({
          toolId: 'some.other.tool',
          inferenceConfig: {
            replacementsId: 'replacements-abc',
            toolDeanonymization: {
              mode: 'allowlist',
              toolIds: ['security.entity_analytics.risk_score'],
            },
          },
        })
      );

      expect(result).toBeUndefined();
    });

    it('fails open and returns undefined when re-anonymization throws', async () => {
      const serviceSetups = createServiceSetups();
      const deps = createDeps({
        getInferenceStart: jest.fn().mockReturnValue({
          getTokenToOriginalMap: jest.fn().mockRejectedValue(new Error('ES error')),
        }),
      });
      registerToolDeanonymizationHooks(serviceSetups, deps);
      const handler = getAfterHandler(serviceSetups);

      const result = await handler(createAfterContext());

      expect(result).toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('ES error'));
    });
  });
});

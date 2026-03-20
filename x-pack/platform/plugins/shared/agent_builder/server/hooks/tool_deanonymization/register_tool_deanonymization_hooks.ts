/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { HookLifecycle, HookExecutionMode } from '@kbn/agent-builder-server';
import type { Logger } from '@kbn/logging';
import type { InferenceServerStart } from '@kbn/inference-plugin/server';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';
import type { InternalSetupServices } from '../../services';
import { getCurrentSpaceId } from '../../utils/spaces';
import { deanonymizeToolParams } from './deanonymize_tool_params';
import { reanonymizeToolReturn } from './reanonymize_tool_return';
import { isToolAllowed, isToolDeanonymizationPolicy } from './types';

export interface RegisterToolDeanonymizationHooksDeps {
  logger: Logger;
  getInferenceStart: () => InferenceServerStart;
  getSpaces: () => SpacesPluginStart | undefined;
}

/**
 * Registers beforeToolCall and afterToolCall hooks that deanonymize tool call
 * arguments before execution and re-anonymize tool results after execution.
 *
 * The deanonymization policy is read from inferenceConfig.toolDeanonymization,
 * which is populated by the beforeInference workflow. Fails open: errors are
 * logged but do not block tool execution.
 */
export function registerToolDeanonymizationHooks(
  serviceSetups: InternalSetupServices,
  deps: RegisterToolDeanonymizationHooksDeps
): void {
  const logger = deps.logger.get('toolDeanonymization');

  // Cache token maps by request object to avoid a second ES fetch in afterToolCall.
  // WeakMap ensures entries are GC'd when the request object is released.
  const tokenMapCache = new WeakMap<object, Map<string, Record<string, string>>>();

  const getTokenMapCached = async (
    request: object,
    spaceId: string,
    replacementsId: string
  ): Promise<Record<string, string> | null> => {
    const cacheKey = `${spaceId}:${replacementsId}`;
    let requestCache = tokenMapCache.get(request);
    if (requestCache?.has(cacheKey)) {
      return requestCache.get(cacheKey)!;
    }

    const tokenToOriginalMap = await deps
      .getInferenceStart()
      .getTokenToOriginalMap(spaceId, replacementsId);

    if (tokenToOriginalMap) {
      if (!requestCache) {
        requestCache = new Map();
        tokenMapCache.set(request, requestCache);
      }
      requestCache.set(cacheKey, tokenToOriginalMap);
    }

    return tokenToOriginalMap;
  };

  const extractDeanonymizationConfig = (
    inferenceConfig: Record<string, unknown>
  ): { toolDeanonymization: unknown; replacementsId: unknown } => {
    const { toolDeanonymization, replacementsId } = inferenceConfig as {
      toolDeanonymization?: unknown;
      replacementsId?: unknown;
    };
    return { toolDeanonymization, replacementsId };
  };

  serviceSetups.hooks.register({
    id: 'tool-deanonymization',
    hooks: {
      [HookLifecycle.beforeToolCall]: {
        mode: HookExecutionMode.blocking,
        handler: async (context) => {
          const { inferenceConfig, toolId, toolParams, request } = context;

          if (!inferenceConfig) {
            return;
          }

          const { toolDeanonymization, replacementsId } =
            extractDeanonymizationConfig(inferenceConfig);

          if (!isToolDeanonymizationPolicy(toolDeanonymization)) {
            return;
          }

          if (typeof replacementsId !== 'string') {
            return;
          }

          if (!isToolAllowed(toolDeanonymization, toolId)) {
            return;
          }

          try {
            const spaces = deps.getSpaces();
            const spaceId = getCurrentSpaceId({ request, spaces });

            const tokenToOriginalMap = await getTokenMapCached(request, spaceId, replacementsId);

            if (!tokenToOriginalMap) {
              return;
            }

            const deanonymizedParams = deanonymizeToolParams(toolParams, tokenToOriginalMap);
            logger.debug(`[beforeToolCall] deanonymized params for tool ${toolId}`);
            return { toolParams: deanonymizedParams };
          } catch (err) {
            logger.error(
              `[beforeToolCall] failed to deanonymize params for tool ${toolId}: ${
                err instanceof Error ? err.message : String(err)
              }`
            );
            return;
          }
        },
      },

      [HookLifecycle.afterToolCall]: {
        mode: HookExecutionMode.blocking,
        handler: async (context) => {
          const { inferenceConfig, toolId, toolReturn, request } = context;

          if (!inferenceConfig) {
            return;
          }

          const { toolDeanonymization, replacementsId } =
            extractDeanonymizationConfig(inferenceConfig);

          if (!isToolDeanonymizationPolicy(toolDeanonymization)) {
            return;
          }

          if (typeof replacementsId !== 'string') {
            return;
          }

          if (!isToolAllowed(toolDeanonymization, toolId)) {
            return;
          }

          try {
            const spaces = deps.getSpaces();
            const spaceId = getCurrentSpaceId({ request, spaces });

            const tokenToOriginalMap = await getTokenMapCached(request, spaceId, replacementsId);

            if (!tokenToOriginalMap) {
              return;
            }

            const reanonymizedReturn = reanonymizeToolReturn(toolReturn, tokenToOriginalMap);
            logger.debug(`[afterToolCall] re-anonymized return for tool ${toolId}`);
            return { toolReturn: reanonymizedReturn };
          } catch (err) {
            logger.error(
              `[afterToolCall] failed to re-anonymize return for tool ${toolId}: ${
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

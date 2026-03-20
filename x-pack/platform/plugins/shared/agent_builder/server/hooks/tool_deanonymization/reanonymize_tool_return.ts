/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ToolResult } from '@kbn/agent-builder-common';
import type { RunToolReturn } from '@kbn/agent-builder-server';

/**
 * Inverts tokenToOriginalMap to produce originalToTokenMap, then recursively
 * walks tool return results replacing original values with anonymization tokens.
 * Tokens are replaced longest-first to avoid partial matches.
 */
export const reanonymizeToolReturn = (
  toolReturn: RunToolReturn,
  tokenToOriginalMap: Record<string, string>
): RunToolReturn => {
  if (!toolReturn.results) {
    return toolReturn;
  }

  const originalToTokenMap = invertMap(tokenToOriginalMap);

  // Sort once here so replaceWithTokens doesn't re-sort on every string.
  const sortedEntries = Object.entries(originalToTokenMap).filter(
    ([original]) => original.length > 0
  );
  sortedEntries.sort(([a], [b]) => b.length - a.length);

  if (sortedEntries.length === 0) {
    return toolReturn;
  }

  return {
    ...toolReturn,
    results: toolReturn.results.map(
      (result) =>
        ({
          ...result,
          data: reanonymizeValue(result.data, sortedEntries),
        } as ToolResult)
    ),
  };
};

const invertMap = (tokenToOriginal: Record<string, string>): Record<string, string> => {
  const inverted: Record<string, string> = {};
  for (const [token, original] of Object.entries(tokenToOriginal)) {
    inverted[original] = token;
  }
  return inverted;
};

const reanonymizeValue = (value: unknown, sortedEntries: Array<[string, string]>): unknown => {
  if (typeof value === 'string') {
    return replaceWithTokens(value, sortedEntries);
  }

  if (Array.isArray(value)) {
    return value.map((item) => reanonymizeValue(item, sortedEntries));
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = reanonymizeValue(val, sortedEntries);
    }
    return result;
  }

  return value;
};

/**
 * Replaces original values with their anonymization tokens in a string.
 * Expects pre-sorted entries (longest-first) to avoid partial replacement issues.
 */
const replaceWithTokens = (text: string, sortedEntries: Array<[string, string]>): string => {
  let result = text;
  for (const [original, token] of sortedEntries) {
    result = result.split(original).join(token);
  }
  return result;
};

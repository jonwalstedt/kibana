/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { replaceTokensWithOriginals } from '@kbn/anonymization-common';

/**
 * Recursively walks tool call parameters and replaces anonymization tokens
 * with their original values. Non-string leaf values are passed through unchanged.
 */
export const deanonymizeToolParams = (
  params: Record<string, unknown>,
  tokenToOriginalMap: Record<string, string>
): Record<string, unknown> => {
  return deanonymizeValue(params, tokenToOriginalMap) as Record<string, unknown>;
};

const deanonymizeValue = (value: unknown, tokenToOriginalMap: Record<string, string>): unknown => {
  if (typeof value === 'string') {
    return replaceTokensWithOriginals(value, tokenToOriginalMap);
  }

  if (Array.isArray(value)) {
    return value.map((item) => deanonymizeValue(item, tokenToOriginalMap));
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = deanonymizeValue(val, tokenToOriginalMap);
    }
    return result;
  }

  return value;
};

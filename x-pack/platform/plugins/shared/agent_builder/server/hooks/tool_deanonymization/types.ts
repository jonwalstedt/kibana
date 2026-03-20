/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

export interface ToolDeanonymizationPolicy {
  /** Controls which tools have their arguments deanonymized before execution. */
  mode: 'allowlist' | 'all' | 'none';
  /**
   * Tool IDs to deanonymize when mode is 'allowlist'.
   * Ignored for other modes.
   */
  toolIds?: string[];
}

export const isToolDeanonymizationPolicy = (value: unknown): value is ToolDeanonymizationPolicy => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return obj.mode === 'allowlist' || obj.mode === 'all' || obj.mode === 'none';
};

/**
 * Returns true if the given toolId should have its arguments deanonymized
 * according to the policy.
 */
export const isToolAllowed = (policy: ToolDeanonymizationPolicy, toolId: string): boolean => {
  if (policy.mode === 'none') {
    return false;
  }
  if (policy.mode === 'all') {
    return true;
  }
  // allowlist
  return policy.toolIds?.includes(toolId) ?? false;
};

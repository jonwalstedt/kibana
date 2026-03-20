/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createHash } from 'crypto';
import { z } from '@kbn/zod/v4';
import type {
  AttachmentTypeDefinition,
  AttachmentFormatContext,
} from '@kbn/agent-builder-server/attachments';
import type { Attachment } from '@kbn/agent-builder-common/attachments';
import { platformCoreTools } from '@kbn/agent-builder-common';
import type { EffectivePolicy } from '@kbn/inference-common';
import { SecurityAgentBuilderAttachments } from '../../../common/constants';
import {
  SECURITY_ENTITY_RISK_SCORE_TOOL_ID,
  SECURITY_ATTACK_DISCOVERY_SEARCH_TOOL_ID,
  SECURITY_LABS_SEARCH_TOOL_ID,
  SECURITY_ALERTS_TOOL_ID,
} from '../tools';
import { securityAttachmentDataSchema } from './security_attachment_data_schema';

export const alertAttachmentDataSchema = securityAttachmentDataSchema
  .extend({
    rawData: z.record(z.string(), z.array(z.string())).optional(),
    /** @deprecated Use rawData instead. Kept for backward compatibility with persisted attachments. */
    alert: z.string().optional(),
  })
  .refine((d) => d.rawData != null || d.alert != null, {
    message: 'Either rawData or alert must be present',
  });

/**
 * Data for an alert attachment.
 */
export type AlertAttachmentData = z.infer<typeof alertAttachmentDataSchema>;

/**
 * Type guard to narrow attachment data to AlertAttachmentData
 */
const isAlertAttachmentData = (data: unknown): data is AlertAttachmentData => {
  return alertAttachmentDataSchema.safeParse(data).success;
};

/**
 * Creates the definition for the `alert` attachment type.
 */
export const createAlertAttachmentType = (): AttachmentTypeDefinition => {
  return {
    id: SecurityAgentBuilderAttachments.alert,
    /**
     * Alert attachments are immutable — the agent can read them but not modify them.
     * isReadonly: true ensures format() is called with the full formatContext (including
     * effectiveFieldPolicy from the beforeInference hook) so field masking is applied
     * before content reaches the LLM.
     */
    isReadonly: true,
    validate: (input) => {
      const parseResult = alertAttachmentDataSchema.safeParse(input);
      if (parseResult.success) {
        return { valid: true, data: parseResult.data };
      } else {
        return { valid: false, error: parseResult.error.message };
      }
    },
    format: (attachment: Attachment<string, unknown>, context: AttachmentFormatContext) => {
      // Extract data to allow proper type narrowing
      const data = attachment.data;
      // Necessary because we cannot currently use the AttachmentType type as agent is not
      // registered with enum AttachmentType in agentBuilder attachment_types.ts
      if (!isAlertAttachmentData(data)) {
        throw new Error(`Invalid alert attachment data for attachment ${attachment.id}`);
      }
      const effectiveFieldPolicy = context.inferenceConfig?.effectiveFieldPolicy as
        | EffectivePolicy
        | undefined;
      const maskField =
        effectiveFieldPolicy && context.collect
          ? buildMaskField(effectiveFieldPolicy, context.collect)
          : undefined;
      return {
        getRepresentation: () => {
          return { type: 'text', value: formatAlertData(data, maskField) };
        },
      };
    },
    getTools: () => [
      SECURITY_ENTITY_RISK_SCORE_TOOL_ID,
      SECURITY_ATTACK_DISCOVERY_SEARCH_TOOL_ID,
      SECURITY_LABS_SEARCH_TOOL_ID,
      SECURITY_ALERTS_TOOL_ID,
      platformCoreTools.cases,
      platformCoreTools.generateEsql,
      platformCoreTools.productDocumentation,
    ],
    getAgentDescription: () => {
      const description = `You have access to security alert data. To provide a comprehensive analysis, you MUST gather enriched context by querying for related information.

SECURITY ALERT DATA:
{alertData}

---
Complete in order:

1. Extract alert id(s): _id
2. Extract rule name: kibana.alert.rule.name
3. Extract entities: host.name, user.name, service.name
4. Extract MITRE fields: kibana.alert.rule.threat.tactic.id, kibana.alert.rule.threat.technique.id, threat.tactic.id
5. Use the available tools to gather context about the alert and provide a response.`;
      return description;
    },
  };
};

/**
 * Builds a maskField function from a pre-resolved effective field policy.
 * For each field value, checks the policy: if `action === 'anonymize'`, replaces the value
 * with a deterministic SHA-256-based token and emits the pair via `collect` so the
 * replacements store can deanonymize the LLM response later.
 */
const buildMaskField = (
  effectiveFieldPolicy: EffectivePolicy,
  collect: (item: unknown) => void
) => {
  return (field: string, value: string): string => {
    const policy = effectiveFieldPolicy[field];
    if (!policy || policy.action !== 'anonymize') {
      return value;
    }
    const entityClass = policy.entityClass ?? 'ENTITY_NAME';
    const hash = createHash('sha256').update(value).digest('hex').slice(0, 16);
    const mask = `${entityClass}_${hash}`;
    collect({ original: value, anonymized: mask, entityClass });
    return mask;
  };
};

/**
 * Formats alert data for display, optionally masking field values with the provided function.
 * Falls back to the legacy `alert` string for attachments persisted before the rawData migration.
 */
const formatAlertData = (
  data: AlertAttachmentData,
  maskField?: (field: string, value: string) => string
): string => {
  if (!data.rawData) {
    // Legacy format — no structured data to mask, return as-is.
    return data.alert ?? '';
  }
  if (!maskField) {
    return JSON.stringify(data.rawData);
  }
  const masked: Record<string, string[]> = {};
  for (const [field, values] of Object.entries(data.rawData)) {
    masked[field] = values.map((v) => maskField(field, v));
  }
  return JSON.stringify(masked);
};

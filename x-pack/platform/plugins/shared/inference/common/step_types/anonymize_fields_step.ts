/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { z } from '@kbn/zod/v4';
import type { BaseStepDefinition } from '@kbn/workflows';
import { StepCategory } from '@kbn/workflows';
import { i18n } from '@kbn/i18n';

/**
 * Step type ID for the anonymize_fields step.
 */
export const AnonymizeFieldsStepTypeId = 'anonymize_fields';

const FieldRuleSchema = z.object({
  field: z.string().describe('ECS or custom field name (e.g. host.name).'),
  allowed: z.boolean().describe('Whether this field is permitted for use as context.'),
  anonymized: z
    .boolean()
    .describe('Whether this field value should be tokenized/masked when included.'),
  entity_class: z
    .string()
    .optional()
    .describe('Token class label (e.g. HOST_NAME). Required when anonymized is true.'),
});

/**
 * Effective policy entry — the resolved per-field action.
 */
const EffectiveFieldPolicySchema = z.object({
  action: z.enum(['allow', 'deny', 'anonymize']),
  entityClass: z.string().optional(),
});

const ToolDeanonymizationPolicySchema = z.object({
  mode: z
    .enum(['allowlist', 'all', 'none'])
    .describe(
      'Controls which tools have their arguments deanonymized before execution. ' +
        '"all" deanonymizes every tool, "allowlist" restricts to tool_ids, "none" disables.'
    ),
  tool_ids: z
    .array(z.string())
    .optional()
    .describe('Tool IDs to deanonymize when mode is "allowlist". Ignored for other modes.'),
});

/**
 * Input schema: field rules are by-value — defined inline in the workflow step config.
 */
export const InputSchema = z.object({
  field_rules: z
    .array(FieldRuleSchema)
    .describe('Inline field rules for field-based anonymization.'),
  keep_tokenized: z.boolean().optional().describe('When true, inference keeps tokens in response.'),
  replacements_id: z
    .string()
    .max(512)
    .optional()
    .describe('Replacements session ID to carry forward.'),
  tool_deanonymization: ToolDeanonymizationPolicySchema.optional().describe(
    'Policy controlling which tools receive deanonymized arguments. ' +
      'When omitted, tool arguments are not deanonymized.'
  ),
});

const ToolDeanonymizationPolicyOutputSchema = z.object({
  mode: z.enum(['allowlist', 'all', 'none']),
  toolIds: z.array(z.string()).optional(),
});

/**
 * Output schema: pre-resolved field policy ready for the beforeInference hook.
 * Keys use camelCase to match ChatCompleteAnonymizationMetadata so outputs flow through
 * the hook context without any key mapping.
 */
export const OutputSchema = z.object({
  effectiveFieldPolicy: z
    .record(z.string(), EffectiveFieldPolicySchema)
    .optional()
    .describe('Resolved field → action map for field-based anonymization.'),
  keepTokenized: z.boolean().optional().describe('When true, keep LLM response tokenized.'),
  replacementsId: z
    .string()
    .max(512)
    .optional()
    .describe('Replacements session ID threaded through from input.'),
  toolDeanonymization: ToolDeanonymizationPolicyOutputSchema.optional().describe(
    'Policy controlling which tools receive deanonymized arguments before execution.'
  ),
});

export type AnonymizeFieldsStepInput = z.infer<typeof InputSchema>;
export type AnonymizeFieldsStepOutput = z.infer<typeof OutputSchema>;

/**
 * Common step definition for the anonymize_fields step.
 * Registered by the inference plugin.
 *
 * Config is by-value: field rules are defined inline. The server handler resolves them
 * to an EffectivePolicy once, which flows through the beforeInference hook context and
 * is passed to inference as pre-resolved metadata — no target lookup at inference time.
 */
export const anonymizeFieldsStepCommonDefinition: BaseStepDefinition<
  typeof InputSchema,
  typeof OutputSchema
> = {
  id: AnonymizeFieldsStepTypeId,
  category: StepCategory.Ai,
  label: i18n.translate('xpack.inference.anonymizeFieldsStep.label', {
    defaultMessage: 'Anonymize Fields',
  }),
  description: i18n.translate('xpack.inference.anonymizeFieldsStep.description', {
    defaultMessage:
      'Resolves inline field rules to a per-field anonymization policy for the next AI inference call.',
  }),
  documentation: {
    details: i18n.translate('xpack.inference.anonymizeFieldsStep.documentation.details', {
      defaultMessage:
        'Place this step before an ai.agent step to apply field-based anonymization. ' +
        'Field rules are defined inline (by-value) and resolved once to an effective policy ' +
        '— no external profile lookup happens at inference time.',
    }),
    examples: [
      `## Anonymize specific alert fields before an agent call
\`\`\`yaml
- name: anonymize_fields
  type: ${AnonymizeFieldsStepTypeId}
  with:
    keep_tokenized: true
    field_rules:
      - field: host.name
        allowed: true
        anonymized: true
        entity_class: HOST_NAME
      - field: user.name
        allowed: true
        anonymized: true
        entity_class: USER_NAME
      - field: source.ip
        allowed: true
        anonymized: true
        entity_class: IP

- name: run_agent
  type: ai.agent
  with:
    message: "Analyze this alert: {{ workflow.input.alert }}"
\`\`\``,
    ],
  },
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
};

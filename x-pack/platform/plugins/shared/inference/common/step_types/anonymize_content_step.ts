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
 * Step type ID for the anonymize content step.
 */
export const AnonymizeContentStepTypeId = 'anonymize_content';

/**
 * Inline regex rule — config lives in the workflow step itself (by-value).
 */
const RegexRuleSchema = z.object({
  pattern: z.string().describe('Regular expression pattern to match.'),
  entity_class: z
    .string()
    .describe('Entity class label for matched values (e.g. "IP_ADDRESS", "USERNAME").'),
  enabled: z.boolean().optional().describe('Whether the rule is active. Defaults to true.'),
});

/**
 * Inline NER rule — config lives in the workflow step itself (by-value).
 */
const NerRuleSchema = z.object({
  model_id: z.string().optional().describe('ML model ID for NER (uses default if not specified).'),
  allowed_entity_classes: z
    .array(z.string())
    .optional()
    .describe('Filter to specific entity classes. Matches all classes when omitted.'),
  enabled: z.boolean().optional().describe('Whether the rule is active. Defaults to true.'),
});

/**
 * Input schema: all anonymization config is inline (by-value).
 * No external profile reference — the workflow step itself is the config.
 */
export const InputSchema = z.object({
  regex_rules: z
    .array(RegexRuleSchema)
    .optional()
    .describe('Regex rules to apply for text anonymization.'),
  ner_rules: z
    .array(NerRuleSchema)
    .optional()
    .describe('NER model rules to apply for entity detection.'),
  keep_tokenized: z
    .boolean()
    .optional()
    .describe(
      'When true, inference suppresses server-side deanonymization. ' +
        'The UI is responsible for resolving originals via the replacements API.'
    ),
  replacements_id: z
    .string()
    .max(512)
    .optional()
    .describe('Optional replacements session ID to carry forward across turns.'),
});

/**
 * Output schema: resolved rules ready for the beforeInference hook in Agent Builder.
 * Keys use camelCase to match ChatCompleteAnonymizationMetadata so outputs flow through
 * the hook context without any key mapping.
 */
export const OutputSchema = z.object({
  additionalRules: z
    .array(z.unknown())
    .optional()
    .describe('Resolved AnonymizationRule[] for the inference call.'),
  replacementsId: z
    .string()
    .max(512)
    .optional()
    .describe('Replacements session ID threaded through from input.'),
  keepTokenized: z.boolean().optional().describe('When true, keep LLM response tokenized.'),
});

export type AnonymizeContentStepInput = z.infer<typeof InputSchema>;
export type AnonymizeContentStepOutput = z.infer<typeof OutputSchema>;

/**
 * Common step definition for the anonymize_content step.
 * Registered by the inference plugin (the enforcement point for anonymized LLM calls).
 *
 * Config is by-value: regex and NER rules live inline in the workflow step, not in an
 * external profile. The server handler maps them to AnonymizationRule[] and passes them
 * to inference via the beforeInference hook context (additionalRules).
 */
export const anonymizeContentStepCommonDefinition: BaseStepDefinition<
  typeof InputSchema,
  typeof OutputSchema
> = {
  id: AnonymizeContentStepTypeId,
  category: StepCategory.Ai,
  label: i18n.translate('xpack.inference.anonymizeContentStep.label', {
    defaultMessage: 'Anonymize Content',
  }),
  description: i18n.translate('xpack.inference.anonymizeContentStep.description', {
    defaultMessage:
      'Applies regex and NER anonymization rules to the next AI inference call. ' +
      'Rules are configured inline in the workflow step.',
  }),
  documentation: {
    details: i18n.translate('xpack.inference.anonymizeContentStep.documentation.details', {
      defaultMessage:
        'Place this step before an ai.agent step to apply text anonymization. ' +
        'Regex rules match patterns in free text; NER rules use ML models for entity detection. ' +
        'Rules are accumulated across multiple anonymize_content steps in the same workflow.',
    }),
    examples: [
      `## Anonymize IP addresses and usernames before an agent call
\`\`\`yaml
- name: anonymize
  type: ${AnonymizeContentStepTypeId}
  with:
    keep_tokenized: true
    regex_rules:
      - pattern: "\\\\b(?:[0-9]{1,3}\\\\.){3}[0-9]{1,3}\\\\b"
        entity_class: IP_ADDRESS
      - pattern: "admin|root|svc-[a-z]+"
        entity_class: USERNAME

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

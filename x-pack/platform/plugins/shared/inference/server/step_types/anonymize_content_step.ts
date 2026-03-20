/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { anonymizeContentStepCommonDefinition } from '../../common/step_types/anonymize_content_step';
import type { AnonymizeContentStepInput } from '../../common/step_types/anonymize_content_step';

/**
 * Server step definition for the anonymize_content step.
 *
 * Config is by-value: rules are defined inline in the workflow step and passed directly
 * to inference as additionalRules via the beforeInference hook. No external profile
 * lookup, no async dependencies — purely functional mapping of input to output.
 */
export const getAnonymizeContentStepDefinition = () => ({
  ...anonymizeContentStepCommonDefinition,
  handler: async (context: { input: unknown }) => {
    const input = context.input as AnonymizeContentStepInput;

    const rules = [
      ...(input.regex_rules ?? [])
        .filter((r) => r.enabled !== false)
        .map((r) => ({
          type: 'RegExp' as const,
          enabled: true,
          pattern: r.pattern,
          entityClass: r.entity_class,
        })),
      ...(input.ner_rules ?? [])
        .filter((r) => r.enabled !== false)
        .map((r) => ({
          type: 'NER' as const,
          enabled: true,
          ...(r.model_id ? { modelId: r.model_id } : {}),
          ...(r.allowed_entity_classes ? { allowedEntityClasses: r.allowed_entity_classes } : {}),
        })),
    ];

    const hasOutput =
      rules.length > 0 || input.replacements_id !== undefined || input.keep_tokenized === true;

    if (!hasOutput) {
      return { output: {} };
    }

    return {
      output: {
        ...(rules.length > 0 ? { additionalRules: rules } : {}),
        ...(input.replacements_id ? { replacementsId: input.replacements_id } : {}),
        ...(input.keep_tokenized ? { keepTokenized: true } : {}),
      },
    };
  },
});

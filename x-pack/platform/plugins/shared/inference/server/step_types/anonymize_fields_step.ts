/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { v4 as uuidv4 } from 'uuid';
import { resolveEffectivePolicy } from '@kbn/anonymization-common';
import type { FieldRule } from '@kbn/anonymization-common';
import { anonymizeFieldsStepCommonDefinition } from '../../common/step_types/anonymize_fields_step';
import type { AnonymizeFieldsStepInput } from '../../common/step_types/anonymize_fields_step';

/**
 * Server step definition for the anonymize_fields step.
 *
 * Purely functional: resolves inline field rules to an EffectivePolicy once.
 * The resolved policy flows through the beforeInference hook context and is passed
 * to inference as pre-resolved metadata — no target lookup at inference time.
 */
export const getAnonymizeFieldsStepDefinition = () => ({
  ...anonymizeFieldsStepCommonDefinition,
  handler: async (context: { input: unknown }) => {
    const input = context.input as AnonymizeFieldsStepInput;

    const fieldRules: FieldRule[] = input.field_rules.map((r) => ({
      field: r.field,
      allowed: r.allowed,
      anonymized: r.anonymized,
      ...(r.entity_class ? { entityClass: r.entity_class as FieldRule['entityClass'] } : {}),
    }));

    const effectiveFieldPolicy = resolveEffectivePolicy(fieldRules);

    const toolDeanonymization = input.tool_deanonymization
      ? {
          mode: input.tool_deanonymization.mode,
          ...(input.tool_deanonymization.tool_ids
            ? { toolIds: input.tool_deanonymization.tool_ids }
            : {}),
        }
      : undefined;

    // When tool deanonymization is enabled, a replacementsId is required so the tool
    // call hooks can look up the token→original map. Pre-generate one here so it flows
    // into inferenceConfig → anonymization metadata → prepareAnonymization (which carries
    // it forward via metadata.anonymization.replacementsId, line 92 in prepare_anonymization.ts).
    // This ensures inferenceConfigHolder.current.replacementsId is set before any tool calls.
    const replacementsId = input.replacements_id ?? (toolDeanonymization ? uuidv4() : undefined);

    return {
      output: {
        effectiveFieldPolicy,
        ...(input.keep_tokenized ? { keepTokenized: true } : {}),
        ...(replacementsId ? { replacementsId } : {}),
        ...(toolDeanonymization ? { toolDeanonymization } : {}),
      },
    };
  },
});

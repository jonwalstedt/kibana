/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Attributes } from '@opentelemetry/api';
import type { AnonymizationRule, EffectivePolicy } from './anonymization/types';

/**
 * Set of metadata that can be used then calling the inference APIs
 *
 * @public
 */
export interface ChatCompleteMetadata {
  connectorTelemetry?: ConnectorTelemetryMetadata;
  anonymization?: ChatCompleteAnonymizationMetadata;
  attributes?: Attributes;
}

/**
 * Pass through for the connector telemetry
 */
export interface ConnectorTelemetryMetadata {
  pluginId?: string;
  aggregateBy?: string;
}

export interface ChatCompleteAnonymizationTarget {
  targetType: 'data_view' | 'index_pattern' | 'index';
  targetId: string;
}

const CHAT_COMPLETE_ANONYMIZATION_TARGET_TYPES = new Set<
  ChatCompleteAnonymizationTarget['targetType']
>(['data_view', 'index_pattern', 'index']);

export const isChatCompleteAnonymizationTargetType = (
  value: unknown
): value is ChatCompleteAnonymizationTarget['targetType'] => {
  return (
    typeof value === 'string' &&
    CHAT_COMPLETE_ANONYMIZATION_TARGET_TYPES.has(
      value as ChatCompleteAnonymizationTarget['targetType']
    )
  );
};

/**
 * Optional anonymization metadata consumers can pass so inference can resolve
 * field-based policy for a target.
 */
export interface ChatCompleteAnonymizationMetadata {
  /**
   * @deprecated Use `additionalRules` instead. profileId is no longer used for rule resolution.
   */
  profileId?: string;
  replacementsId?: string;
  target?: ChatCompleteAnonymizationTarget;
  /**
   * When true, inference suppresses server-side deanonymization so the LLM
   * response is stored with tokens intact. The UI is then responsible for
   * resolving originals via the replacements API.
   *
   * RFC §7.5: preferred approach for consumers that own their own rendering
   * layer (e.g. Agent Builder) and want permission-gated reveal.
   */
  keepTokenized?: boolean;
  /**
   * Pre-resolved additional anonymization rules (by-value from caller).
   * Merged with space-global rules in prepareAnonymization.
   * Replaces the profileId-based lazy resolution pattern.
   */
  additionalRules?: AnonymizationRule[];
  /**
   * Pre-resolved field-based effective policy (by-value from caller).
   * Produced by the anonymize_fields workflow step and passed through the
   * beforeInference hook. When present, used directly by prepareAnonymization
   * — no target lookup required.
   */
  effectiveFieldPolicy?: EffectivePolicy;
  /**
   * Anonymization pairs computed by attachment formatters at format time.
   * Injected as initial anonymizations so the replacements store records them
   * even though the original values no longer appear in message content.
   */
  attachmentAnonymizations?: Array<{ original: string; anonymized: string; entityClass: string }>;
}

const ANONYMIZATION_METADATA_KEYS: ReadonlyArray<keyof ChatCompleteAnonymizationMetadata> = [
  'profileId',
  'replacementsId',
  'target',
  'keepTokenized',
  'additionalRules',
  'effectiveFieldPolicy',
  'attachmentAnonymizations',
];

/**
 * Type guard for ChatCompleteAnonymizationMetadata.
 *
 * All fields are optional so a pure structural check would accept any object.
 * This guard requires at least one known anonymization key to be present, which
 * allows callers to pass an opaque Record<string, unknown> (e.g. from the
 * beforeInference hook) and only treat it as anonymization metadata when it
 * actually contains anonymization-relevant fields.
 */
export const isChatCompleteAnonymizationMetadata = (
  value: unknown
): value is ChatCompleteAnonymizationMetadata => {
  if (typeof value !== 'object' || value === null) return false;
  return ANONYMIZATION_METADATA_KEYS.some((key) => key in value);
};

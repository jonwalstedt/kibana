/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { v4 as uuidv4 } from 'uuid';
import type { ElasticsearchClient } from '@kbn/core/server';
import type { Logger } from '@kbn/logging';
import type {
  AnonymizationRule,
  ChatCompleteAnonymizationTarget,
  ChatCompleteOptions,
} from '@kbn/inference-common';
import { createInferenceRequestError } from '@kbn/inference-common';
import type { EffectivePolicy } from '@kbn/anonymization-common';
import { MAX_TEXT_RULES_PER_PROFILE } from '@kbn/anonymization-common';
import { anonymizeMessages } from './anonymization/anonymize_messages';
import type { RegexWorkerService } from './anonymization/regex_worker_service';
import { ReplacementsRepository } from './anonymization/replacements/replacements_repository';
import { ReplacementsNamespaceMismatchError } from './anonymization/replacements/replacements_errors';
import { ensureReplacementsIndex } from './anonymization/replacements/replacements_index';
import { isConflictError, withShardRecoveryRetry } from './utils';

interface PrepareAnonymizationOptions {
  namespace: string;
  logger: Logger;
  anonymizationRules: AnonymizationRule[];
  regexWorker: RegexWorkerService;
  esClient: ElasticsearchClient;
  replacementsEsClient?: ElasticsearchClient;
  replacementsEncryptionKeyPromise?: Promise<string | undefined>;
  usePersistentReplacements?: boolean;
  requireReplacementsEncryptionKey?: boolean;
  saltPromise?: Promise<string | undefined>;
  resolveEffectivePolicy?: (
    target?: ChatCompleteAnonymizationTarget
  ) => Promise<EffectivePolicy | undefined>;
  metadata?: ChatCompleteOptions['metadata'];
  system?: ChatCompleteOptions['system'];
  messages: ChatCompleteOptions['messages'];
}

export const prepareAnonymization = async ({
  namespace,
  logger,
  anonymizationRules,
  regexWorker,
  esClient,
  replacementsEsClient,
  replacementsEncryptionKeyPromise,
  usePersistentReplacements = true,
  requireReplacementsEncryptionKey = false,
  saltPromise,
  resolveEffectivePolicy,
  metadata,
  system,
  messages,
}: PrepareAnonymizationOptions) => {
  const salt = await saltPromise;
  // Prefer pre-resolved by-value policy from the anonymize_fields workflow step; fall back to
  // target-based lookup only when no pre-resolved policy is provided.
  const effectivePolicy: EffectivePolicy | undefined =
    (metadata?.anonymization?.effectiveFieldPolicy as EffectivePolicy | undefined) ??
    (await resolveEffectivePolicy?.(metadata?.anonymization?.target));

  // When additionalRules are present (pre-resolved by-value from caller), merge them with
  // the space-scoped global default rules. Merge is by rule ID when present (non-destructive);
  // global rules win on conflict. The combined set is capped at MAX_TEXT_RULES_PER_PROFILE to
  // bound worst-case cost.
  const additionalRules = metadata?.anonymization?.additionalRules;
  const mergedAnonymizationRules = additionalRules?.length
    ? mergeAnonymizationRules(anonymizationRules, additionalRules, logger)
    : anonymizationRules;
  const attachmentAnonymizations = metadata?.anonymization?.attachmentAnonymizations;

  if (!usePersistentReplacements) {
    const anonymization = await anonymizeMessages({
      system,
      messages,
      anonymizationRules: mergedAnonymizationRules,
      regexWorker,
      esClient,
      salt: salt ?? undefined,
      effectivePolicy,
      attachmentAnonymizations,
    });
    return { anonymization, replacementsId: undefined, effectivePolicy };
  }

  const carriedReplacementsId = metadata?.anonymization?.replacementsId;
  const replacementsClient = replacementsEsClient ?? esClient;
  let repo: ReplacementsRepository | undefined;
  let replacementsId = carriedReplacementsId;
  let resolvedReplacementsEncryptionKey: string | undefined;

  const getReplacementsEncryptionKey = async (): Promise<string | undefined> => {
    if (resolvedReplacementsEncryptionKey) {
      return resolvedReplacementsEncryptionKey;
    }
    resolvedReplacementsEncryptionKey = await replacementsEncryptionKeyPromise;
    return resolvedReplacementsEncryptionKey;
  };

  if (carriedReplacementsId) {
    const encryptionKey = await getReplacementsEncryptionKey();
    if (requireReplacementsEncryptionKey && !encryptionKey) {
      throw createInferenceRequestError(
        'Replacements encryption key is not available — verify the anonymization plugin is active and properly initialized',
        400
      );
    }
    await withShardRecoveryRetry({
      logger,
      operation: 'ensure_replacements_index',
      action: () => ensureReplacementsIndex({ esClient: replacementsClient, logger }),
    });
    repo = new ReplacementsRepository(replacementsClient, {
      encryptionKey,
      logger,
    });
  }

  let existingReplacements = carriedReplacementsId
    ? await withShardRecoveryRetry({
      logger,
      operation: 'get_replacements',
      action: async () => {
        try {
          return await repo?.get(namespace, carriedReplacementsId);
        } catch (error) {
          if (error instanceof ReplacementsNamespaceMismatchError) {
            // The carried replacementsId belongs to a different namespace (e.g. after a space
            // migration). Fall back to generating a fresh document rather than hard-erroring —
            // callers that persisted an old ID before migration should not receive a 409.
            logger.warn(
              `[inference.anonymization.namespace_mismatch] replacements_id=${carriedReplacementsId} requested_namespace=${namespace} actual_namespace=${error.meta.actualNamespace} — falling back to new replacements document`
            );
            replacementsId = uuidv4();
            return null;
          }
          throw error;
        }
      },
    })
    : null;

  const anonymization = await anonymizeMessages({
    system,
    messages,
    anonymizationRules: mergedAnonymizationRules,
    regexWorker,
    esClient,
    salt: salt ?? undefined,
    effectivePolicy,
    knownReplacements: (existingReplacements?.replacements ?? []).filter(
      (r): r is { anonymized: string; original: string } =>
        typeof r.anonymized === 'string' && typeof r.original === 'string'
    ),
    attachmentAnonymizations,
  });

  const replacements = anonymization.anonymizations.map(({ entity }) => ({
    anonymized: entity.mask,
    original: entity.value,
  }));
  const shouldPersistReplacements = Boolean(carriedReplacementsId || replacements.length);

  if (!shouldPersistReplacements) {
    return { anonymization, replacementsId: undefined, effectivePolicy };
  }

  const encryptionKey = await getReplacementsEncryptionKey();
  if (requireReplacementsEncryptionKey && !encryptionKey) {
    throw createInferenceRequestError(
      'Replacements encryption key is not available — verify the anonymization plugin is active and properly initialized',
      400
    );
  }

  replacementsId ??= uuidv4();

  if (!repo) {
    await withShardRecoveryRetry({
      logger,
      operation: 'ensure_replacements_index',
      action: () => ensureReplacementsIndex({ esClient: replacementsClient, logger }),
    });
    repo = new ReplacementsRepository(replacementsClient, {
      encryptionKey,
      logger,
    });
  }

  if (existingReplacements) {
    try {
      if (!replacementsId) {
        throw new Error(
          'Invariant violation: existing replacements found without a replacementsId'
        );
      }
      const replacementsIdForUpdate = replacementsId;
      const updated = await withShardRecoveryRetry({
        logger,
        operation: 'update_replacements',
        action: () => repo.update(namespace, replacementsIdForUpdate, { replacements }),
      });
      if (!updated) {
        replacementsId = uuidv4();
        existingReplacements = null;
      }
    } catch (updateErr) {
      if (updateErr instanceof ReplacementsNamespaceMismatchError) {
        // The document was moved to a different namespace between the get and update.
        // Propagate rather than silently allocating a new UUID for the wrong tenant.
        throw updateErr;
      }
      // isRetryableShardRecoveryError is already handled inside withShardRecoveryRetry;
      // if retries are exhausted the error propagates normally here.
      logger.warn(
        `Replacements update failed for ${replacementsId}, creating new document: ${updateErr instanceof Error ? updateErr.message : String(updateErr)
        }`
      );
      replacementsId = uuidv4();
      existingReplacements = null;
    }
  }

  if (!existingReplacements) {
    // replacementsId is always a string here (set by ??= above or by fallback paths),
    // but TypeScript can't narrow let-bindings inside closures — capture as a const.
    const replacementsIdToCreate = replacementsId as string;
    try {
      await withShardRecoveryRetry({
        logger,
        operation: 'create_replacements',
        action: () =>
          repo.create({
            id: replacementsIdToCreate,
            namespace,
            createdBy: 'inference',
            replacements,
          }),
      });
    } catch (createErr) {
      // Another concurrent request may have created this replacements document first.
      if (!isConflictError(createErr)) {
        throw createErr;
      }
      logger.warn(
        `[inference.anonymization.create_conflict_fallback] replacements_id=${replacementsIdToCreate} namespace=${namespace} triggered=true`
      );
      const updatedAfterConflict = await withShardRecoveryRetry({
        logger,
        operation: 'update_replacements_after_conflict',
        action: () => repo.update(namespace, replacementsIdToCreate, { replacements }),
      });
      if (!updatedAfterConflict) {
        throw createInferenceRequestError(
          `Unable to persist replacements after create conflict for replacementsId "${replacementsIdToCreate}"`,
          409
        );
      }
    }
  }

  return { anonymization, replacementsId, effectivePolicy };
};

/**
 * Merges global default anonymization rules with profile-specific rules.
 *
 * Semantics — additive, non-destructive ID merge (RFC-aligned):
 * - Rules are merged by rule ID when present. If both global and profile rules share
 *   the same ID, the global rule is kept and the profile rule is ignored.
 * - Rules without IDs are treated as unique and are always included.
 * - If combined count exceeds MAX_TEXT_RULES_PER_PROFILE, profile rules are trimmed
 *   first to preserve the global baseline rules.
 *
 * @internal exported for unit testing only
 */
export function mergeAnonymizationRules(
  globalRules: AnonymizationRule[],
  profileRules: AnonymizationRule[],
  logger: Logger
): AnonymizationRule[] {
  const globalRuleIds = new Set<string>(
    globalRules.map((rule) => rule.id).filter((id): id is string => typeof id === 'string')
  );

  const filteredProfile = profileRules.filter((rule) => !(rule.id && globalRuleIds.has(rule.id)));

  // Profile rules go at the end; trimming from the end removes profile overflow first.
  const merged = [...globalRules, ...filteredProfile];

  if (merged.length > MAX_TEXT_RULES_PER_PROFILE) {
    const excess = merged.length - MAX_TEXT_RULES_PER_PROFILE;
    logger.warn(
      `[inference.anonymization.merge] combined rule count ${merged.length} exceeds cap ${MAX_TEXT_RULES_PER_PROFILE}; trimming ${excess} profile rule(s) to preserve global rules`
    );
    return merged.slice(0, MAX_TEXT_RULES_PER_PROFILE);
  }

  return merged;
}

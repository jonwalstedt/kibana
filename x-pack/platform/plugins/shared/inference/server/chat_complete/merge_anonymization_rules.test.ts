/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type {
  AnonymizationRule,
  RegexAnonymizationRule,
  NamedEntityRecognitionRule,
} from '@kbn/inference-common';
import { loggerMock } from '@kbn/logging-mocks';
import { mergeAnonymizationRules } from './prepare_anonymization';

const regex = (
  id: string | undefined,
  pattern: string,
  entityClass = 'EMAIL'
): RegexAnonymizationRule => ({
  ...(id ? { id } : {}),
  type: 'RegExp',
  enabled: true,
  pattern,
  entityClass: entityClass as RegexAnonymizationRule['entityClass'],
});

const ner = (id: string | undefined, modelId?: string): NamedEntityRecognitionRule => ({
  ...(id ? { id } : {}),
  type: 'NER',
  enabled: true,
  ...(modelId ? { modelId } : {}),
  allowedEntityClasses: ['PER'],
});

describe('mergeAnonymizationRules', () => {
  const logger = loggerMock.create();

  beforeEach(() => jest.clearAllMocks());

  describe('additive merge', () => {
    it('keeps all global rules when profile has no overlapping rules', () => {
      const global = [regex('g-1', '\\d{3}-\\d{2}-\\d{4}', 'IP'), ner('g-2', 'model-a')];
      const profile = [regex('p-1', '[a-z]+@[a-z]+\\.com', 'EMAIL')];

      const result = mergeAnonymizationRules(global, profile, logger);

      expect(result).toHaveLength(3);
      expect(result).toEqual(expect.arrayContaining([...global, ...profile]));
    });

    it('keeps global NER rules whose IDs do NOT overlap with the profile', () => {
      const globalNer = ner('g-ner', 'model-a');
      const profileNer = ner('p-ner', 'model-a');
      const result = mergeAnonymizationRules([globalNer], [profileNer], logger);

      // Both NER rules survive — different IDs
      expect(result).toHaveLength(2);
      expect(result).toContainEqual(globalNer);
      expect(result).toContainEqual(profileNer);
    });
  });

  describe('conflict resolution — global wins', () => {
    it('keeps a global regex rule when the profile has the same rule ID', () => {
      const globalRegex: RegexAnonymizationRule = {
        id: 'rule-1',
        type: 'RegExp',
        enabled: true,
        pattern: 'foo',
        entityClass: 'EMAIL',
      };
      const profileRegex: RegexAnonymizationRule = {
        id: 'rule-1',
        type: 'RegExp',
        enabled: false,
        pattern: 'bar',
        entityClass: 'EMAIL',
      };

      const result = mergeAnonymizationRules([globalRegex], [profileRegex], logger);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(globalRegex); // global version kept
    });

    it('keeps a global NER rule when the profile has the same rule ID', () => {
      const globalNer: NamedEntityRecognitionRule = {
        id: 'rule-ner',
        type: 'NER',
        enabled: true,
        modelId: 'ner-v1',
        allowedEntityClasses: ['PER'],
      };
      const profileNer: NamedEntityRecognitionRule = {
        id: 'rule-ner',
        type: 'NER',
        enabled: true,
        modelId: 'ner-v1',
        allowedEntityClasses: ['PER', 'ORG'],
      };

      const result = mergeAnonymizationRules([globalNer], [profileNer], logger);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(globalNer);
    });

    it('keeps both regex rules when IDs differ even if pattern is identical', () => {
      const globalRegex = regex('g-1', 'foo', 'EMAIL');
      const profileRegex = regex('p-1', 'foo', 'EMAIL');

      const result = mergeAnonymizationRules([globalRegex], [profileRegex], logger);

      expect(result).toHaveLength(2);
      expect(result).toContainEqual(globalRegex);
      expect(result).toContainEqual(profileRegex);
    });

    it('keeps profile rules without IDs even if they look similar', () => {
      const globalRegex = regex('g-1', 'foo', 'EMAIL');
      const profileNer: NamedEntityRecognitionRule = {
        type: 'NER',
        enabled: true,
        allowedEntityClasses: ['ORG'],
      };

      const result = mergeAnonymizationRules([globalRegex], [profileNer], logger);

      expect(result).toHaveLength(2);
      expect(result).toContainEqual(globalRegex);
      expect(result).toContainEqual(profileNer);
    });
  });

  describe('cap behavior — profile trimmed first', () => {
    it('trims profile rules from the end when combined count exceeds cap', () => {
      // Create 45 global rules and 10 profile rules (total 55 > MAX 50)
      const globalRules: AnonymizationRule[] = Array.from({ length: 45 }, (_, i) =>
        regex(`g-${i}`, `global-pattern-${i}`, 'EMAIL')
      );
      const profileRules: AnonymizationRule[] = Array.from({ length: 10 }, (_, i) =>
        regex(`p-${i}`, `profile-pattern-${i}`, 'EMAIL')
      );

      const result = mergeAnonymizationRules(globalRules, profileRules, logger);

      expect(result).toHaveLength(50);
      // All 45 global rules must be present
      for (const globalRule of globalRules) {
        expect(result).toContainEqual(globalRule);
      }
      // Only 5 of the 10 profile rules survive (5 trimmed from end)
      const resultPatterns = result
        .filter((r): r is Extract<AnonymizationRule, { type: 'RegExp' }> => r.type === 'RegExp')
        .map((r) => r.pattern);
      const profileResultCount = resultPatterns.filter((p) => p.startsWith('profile-')).length;
      expect(profileResultCount).toBe(5);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('trimming 5 profile rule(s)')
      );
    });

    it('does not warn when combined count is within cap', () => {
      const result = mergeAnonymizationRules([regex('g-1', 'a')], [regex('p-1', 'b')], logger);
      expect(result).toHaveLength(2);
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });
});

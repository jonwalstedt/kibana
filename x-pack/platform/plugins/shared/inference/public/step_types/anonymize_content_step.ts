/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { anonymizeContentStepCommonDefinition } from '../../common/step_types/anonymize_content_step';

/**
 * Public step definition for the anonymize_content step.
 *
 * Config is by-value: regex and NER rules live inline in the workflow step.
 * No profile picker or external profile resolution needed.
 */
export const createAnonymizeContentStepDefinition = () => ({
  ...anonymizeContentStepCommonDefinition,
});

/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { anonymizeFieldsStepCommonDefinition } from '../../common/step_types/anonymize_fields_step';

/**
 * Public step definition for the anonymize_fields step.
 *
 * Config is by-value: the field rules live inline in the workflow step config.
 */
export const createAnonymizeFieldsStepDefinition = () => ({
  ...anonymizeFieldsStepCommonDefinition,
});

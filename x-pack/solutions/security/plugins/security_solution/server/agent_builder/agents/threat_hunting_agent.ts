/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { BuiltInAgentDefinition } from '@kbn/agent-builder-server/agents';
import { platformCoreTools } from '@kbn/agent-builder-common';
import type { Logger } from '@kbn/logging';
import type { WorkflowsServerPluginSetup } from '@kbn/workflows-management-plugin/server';
import { THREAT_HUNTING_AGENT_ID } from '../../../common/constants';
import {
  SECURITY_ATTACK_DISCOVERY_SEARCH_TOOL_ID,
  SECURITY_LABS_SEARCH_TOOL_ID,
  SECURITY_ALERTS_TOOL_ID,
  SECURITY_ENTITY_RISK_SCORE_TOOL_ID,
} from '../tools';
import type { SecuritySolutionPluginCoreSetupDependencies } from '../../plugin_contract';
import { getAgentBuilderResourceAvailability } from '../utils/get_agent_builder_resource_availability';

const PLATFORM_TOOL_IDS = [
  platformCoreTools.search,
  platformCoreTools.listIndices,
  platformCoreTools.getIndexMapping,
  platformCoreTools.getDocumentById,
  platformCoreTools.cases,
  platformCoreTools.productDocumentation,
  platformCoreTools.generateEsql,
  platformCoreTools.executeEsql,
];

const SECURITY_TOOL_IDS = [
  SECURITY_ALERTS_TOOL_ID,
  SECURITY_ATTACK_DISCOVERY_SEARCH_TOOL_ID,
  SECURITY_ENTITY_RISK_SCORE_TOOL_ID,
  SECURITY_LABS_SEARCH_TOOL_ID,
];

export const THREAT_HUNTING_AGENT_TOOL_IDS = [...PLATFORM_TOOL_IDS, ...SECURITY_TOOL_IDS];

/**
 * Workflow tags used to wire alert-anonymization workflows into the Threat Hunting Agent.
 * Tag a workflow with BOTH tags to have it run automatically in the beforeInference lifecycle.
 */
const ANONYMIZATION_WORKFLOW_TAG = 'anonymization';
const ALERTS_WORKFLOW_TAG = 'alerts';

/**
 * Looks up enabled workflows that have both the anonymization and alerts tags in the given space.
 * These workflows are automatically wired into the Threat Hunting Agent's beforeInference
 * lifecycle so alert field values are masked before reaching the LLM.
 *
 * Note: WorkflowListItemDto.tags is not populated by the list service — tag filtering is done
 * against definition.tags instead. The enabled filter is the only server-side filter applied.
 */
const getAlertAnonymizationWorkflowIds = async (
  workflowsManagement: WorkflowsServerPluginSetup,
  spaceId: string,
  logger: Logger
): Promise<string[]> => {
  try {
    const result = await workflowsManagement.management.getWorkflows(
      { enabled: [true], size: 100, page: 1 },
      spaceId
    );
    return result.results
      .filter(
        (w) =>
          w.definition?.tags?.includes(ANONYMIZATION_WORKFLOW_TAG) &&
          w.definition?.tags?.includes(ALERTS_WORKFLOW_TAG)
      )
      .map((w) => w.id);
  } catch (err) {
    logger.warn(`Failed to fetch anonymization workflows: ${err}`);
    return [];
  }
};

export const createThreatHuntingAgent = (
  core: SecuritySolutionPluginCoreSetupDependencies,
  logger: Logger,
  workflowsManagement?: WorkflowsServerPluginSetup
): BuiltInAgentDefinition => {
  return {
    id: THREAT_HUNTING_AGENT_ID,
    avatar_icon: 'logoSecurity',
    name: 'Threat Hunting Agent',
    description:
      'Agent specialized in security alert analysis and entity analysis tasks, including alert investigation, entity investigation and security documentation.',
    labels: ['security'],
    availability: {
      cacheMode: 'space',
      handler: async ({ request }) => {
        return getAgentBuilderResourceAvailability({ core, request, logger });
      },
    },
    configuration: async ({ spaceId }) => {
      const beforeInferenceWorkflowIds = workflowsManagement
        ? await getAlertAnonymizationWorkflowIds(workflowsManagement, spaceId, logger)
        : [];

      return {
        instructions: `You are a security analyst and expert in resolving security incidents. Your role is to assist by answering questions about Elastic Security.`,
        tools: [
          {
            tool_ids: THREAT_HUNTING_AGENT_TOOL_IDS,
          },
        ],
        ...(beforeInferenceWorkflowIds.length > 0
          ? { lifecycle_workflows: { beforeInference: beforeInferenceWorkflowIds } }
          : {}),
      };
    },
  };
};

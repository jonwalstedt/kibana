/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Attachment } from '@kbn/agent-builder-common/attachments';
import { platformCoreTools } from '@kbn/agent-builder-common';
import { agentBuilderMocks } from '@kbn/agent-builder-plugin/server/mocks';
import { SecurityAgentBuilderAttachments } from '../../../common/constants';
import {
  SECURITY_ENTITY_RISK_SCORE_TOOL_ID,
  SECURITY_ATTACK_DISCOVERY_SEARCH_TOOL_ID,
  SECURITY_LABS_SEARCH_TOOL_ID,
  SECURITY_ALERTS_TOOL_ID,
} from '../tools';
import { createAlertAttachmentType } from './alert';

describe('createAlertAttachmentType', () => {
  const attachmentType = createAlertAttachmentType();
  const formatContext = agentBuilderMocks.attachments.createFormatContextMock();

  describe('validate', () => {
    it('returns valid when alert data is valid', async () => {
      const input = {
        rawData: { 'host.name': ['test-host'], 'user.name': ['test-user'] },
        attachmentLabel: 'Security Alert',
      };

      const result = await attachmentType.validate(input);

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.data).toEqual(input);
      }
    });

    it('returns valid for legacy alert string format (backward compat)', async () => {
      const input = { alert: 'test alert data', attachmentLabel: 'Security Alert' };

      const result = await attachmentType.validate(input);

      expect(result.valid).toBe(true);
    });

    it('returns invalid when both rawData and alert fields are missing', async () => {
      const input = {};

      const result = await attachmentType.validate(input);

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBeDefined();
      }
    });

    it('returns invalid when rawData field is not a record', async () => {
      const input = { rawData: 'not-a-record', attachmentLabel: 'Security Alert' };

      const result = await attachmentType.validate(input);

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBeDefined();
      }
    });
  });

  describe('format', () => {
    it('returns JSON-serialized rawData as text representation', async () => {
      const rawData = { 'host.name': ['frizzy-reach.info'], 'user.name': ['Carmela66'] };
      const attachment: Attachment<string, unknown> = {
        id: 'test-id',
        type: SecurityAgentBuilderAttachments.alert,
        data: { rawData, attachmentLabel: 'Security Alert' },
      };

      const formatted = await attachmentType.format(attachment, formatContext);
      const representation = formatted.getRepresentation
        ? await formatted.getRepresentation()
        : { type: 'text', value: attachment.data };

      expect(representation.type).toBe('text');
      expect(representation.value).toBe(JSON.stringify(rawData));
    });

    it('applies field masking when effectiveFieldPolicy is provided via inferenceConfig', async () => {
      const rawData = { 'host.name': ['frizzy-reach.info'], 'user.name': ['Carmela66'] };
      const attachment: Attachment<string, unknown> = {
        id: 'test-id',
        type: SecurityAgentBuilderAttachments.alert,
        data: { rawData, attachmentLabel: 'Security Alert' },
      };
      const collected: unknown[] = [];
      const contextWithPolicy = {
        ...formatContext,
        inferenceConfig: {
          effectiveFieldPolicy: {
            'host.name': { action: 'anonymize', entityClass: 'HOST_NAME' },
            'user.name': { action: 'anonymize', entityClass: 'USER_NAME' },
          },
        },
        collect: (item: unknown) => collected.push(item),
      };

      const formatted = await attachmentType.format(attachment, contextWithPolicy);
      const representation = formatted.getRepresentation
        ? await formatted.getRepresentation()
        : undefined;

      expect(representation?.type).toBe('text');
      const parsed = JSON.parse(representation?.value as string);

      // Values are replaced with deterministic tokens
      expect(parsed['host.name']).toHaveLength(1);
      expect(parsed['host.name'][0]).toMatch(/^HOST_NAME_[0-9a-f]{16}$/);
      expect(parsed['user.name']).toHaveLength(1);
      expect(parsed['user.name'][0]).toMatch(/^USER_NAME_[0-9a-f]{16}$/);

      // Original values do not appear in output
      expect(parsed['host.name'][0]).not.toContain('frizzy-reach.info');
      expect(parsed['user.name'][0]).not.toContain('Carmela66');

      // collect is called for each masked value so the replacements store can deanonymize
      expect(collected).toHaveLength(2);
      expect(collected).toContainEqual(
        expect.objectContaining({ original: 'frizzy-reach.info', entityClass: 'HOST_NAME' })
      );
      expect(collected).toContainEqual(
        expect.objectContaining({ original: 'Carmela66', entityClass: 'USER_NAME' })
      );
    });

    it('does not mask fields with action allow or deny', async () => {
      const rawData = { 'host.name': ['allowed-host'], 'source.ip': ['1.2.3.4'] };
      const attachment: Attachment<string, unknown> = {
        id: 'test-id',
        type: SecurityAgentBuilderAttachments.alert,
        data: { rawData, attachmentLabel: 'Security Alert' },
      };
      const collected: unknown[] = [];
      const contextWithPolicy = {
        ...formatContext,
        inferenceConfig: {
          effectiveFieldPolicy: {
            'host.name': { action: 'allow' },
            'source.ip': { action: 'deny' },
          },
        },
        collect: (item: unknown) => collected.push(item),
      };

      const formatted = await attachmentType.format(attachment, contextWithPolicy);
      const representation = formatted.getRepresentation
        ? await formatted.getRepresentation()
        : undefined;

      const parsed = JSON.parse(representation?.value as string);
      expect(parsed['host.name']).toEqual(['allowed-host']);
      expect(parsed['source.ip']).toEqual(['1.2.3.4']);
      expect(collected).toHaveLength(0);
    });

    it('renders legacy alert string as-is (backward compat)', async () => {
      const attachment: Attachment<string, unknown> = {
        id: 'test-id',
        type: SecurityAgentBuilderAttachments.alert,
        data: { alert: 'legacy alert content', attachmentLabel: 'Security Alert' },
      };

      const formatted = await attachmentType.format(attachment, formatContext);
      const representation = formatted.getRepresentation
        ? await formatted.getRepresentation()
        : undefined;

      expect(representation?.type).toBe('text');
      expect(representation?.value).toBe('legacy alert content');
    });

    it('throws error when attachment data is invalid', () => {
      const attachment: Attachment<string, unknown> = {
        id: 'test-id',
        type: SecurityAgentBuilderAttachments.alert,
        data: { invalid: 'data', attachmentLabel: 'Security Alert' },
      };

      expect(() => attachmentType.format(attachment, formatContext)).toThrow(
        'Invalid alert attachment data for attachment test-id'
      );
    });
  });

  describe('getTools', () => {
    it('returns expected tool IDs', () => {
      const tools = attachmentType.getTools?.();

      expect(tools).toBeDefined();
      if (tools) {
        expect(tools).toContain(SECURITY_ENTITY_RISK_SCORE_TOOL_ID);
        expect(tools).toContain(SECURITY_ATTACK_DISCOVERY_SEARCH_TOOL_ID);
        expect(tools).toContain(SECURITY_LABS_SEARCH_TOOL_ID);
        expect(tools).toContain(SECURITY_ALERTS_TOOL_ID);
        expect(tools).toContain(platformCoreTools.cases);
        expect(tools).toContain(platformCoreTools.generateEsql);
        expect(tools).toContain(platformCoreTools.productDocumentation);
      }
    });
  });

  describe('getAgentDescription', () => {
    it('returns expected description', () => {
      const description = attachmentType.getAgentDescription?.();

      expect(description).toContain('security alert data');
      expect(description).toContain('SECURITY ALERT DATA');
      expect(description).toContain('Extract alert id(s): _id');
      expect(description).toContain('Extract rule name: kibana.alert.rule.name');
      expect(description).toContain('Extract entities: host.name, user.name, service.name');
    });
  });
});

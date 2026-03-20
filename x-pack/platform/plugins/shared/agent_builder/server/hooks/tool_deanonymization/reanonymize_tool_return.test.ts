/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { ToolResultType } from '@kbn/agent-builder-common';
import { reanonymizeToolReturn } from './reanonymize_tool_return';

const HOST_TOKEN = 'HOST_NAME_abc123';
const IP_TOKEN = 'IP_ADDR_def456';
const HOST_ORIGINAL = 'frizzy-reach.info';
const IP_ORIGINAL = '192.168.1.1';

const makeTextResult = (text: string) => ({
  type: ToolResultType.other as const,
  data: text,
  tool_result_id: 'result-1',
});

describe('reanonymizeToolReturn', () => {
  const tokenToOriginalMap = Object.fromEntries([
    [HOST_TOKEN, HOST_ORIGINAL],
    [IP_TOKEN, IP_ORIGINAL],
  ]);

  it('replaces original values with tokens in result data', () => {
    const toolReturn = {
      results: [makeTextResult(`Risk score for ${HOST_ORIGINAL}: 85`)],
    };
    const result = reanonymizeToolReturn(toolReturn, tokenToOriginalMap);
    expect(result.results?.[0].data).toBe(`Risk score for ${HOST_TOKEN}: 85`);
  });

  it('replaces multiple original values in one result', () => {
    const toolReturn = {
      results: [makeTextResult(`Host ${HOST_ORIGINAL} has IP ${IP_ORIGINAL}`)],
    };
    const result = reanonymizeToolReturn(toolReturn, tokenToOriginalMap);
    expect(result.results?.[0].data).toBe(`Host ${HOST_TOKEN} has IP ${IP_TOKEN}`);
  });

  it('handles results with no originals to replace', () => {
    const toolReturn = {
      results: [makeTextResult('No sensitive data here')],
    };
    const result = reanonymizeToolReturn(toolReturn, tokenToOriginalMap);
    expect(result.results?.[0].data).toBe('No sensitive data here');
  });

  it('returns toolReturn unchanged when no results', () => {
    const toolReturn = { prompt: { id: 'confirm-123', message: 'Continue?' } as any };
    const result = reanonymizeToolReturn(toolReturn, tokenToOriginalMap);
    expect(result).toBe(toolReturn);
  });

  it('applies longest-first replacement to avoid partial matches', () => {
    // If 'abc' is an original and 'abcdef' is also an original, 'abcdef' should be
    // matched first so 'abc' doesn't partially match inside 'abcdef'.
    const map = {
      TOKEN_SHORT: 'abc',
      TOKEN_LONG: 'abcdef',
    };
    const toolReturn = {
      results: [makeTextResult('value abcdef and value abc')],
    };
    const result = reanonymizeToolReturn(toolReturn, map);
    // 'abcdef' → TOKEN_LONG (matched first), then 'abc' → TOKEN_SHORT
    expect(result.results?.[0].data).toBe('value TOKEN_LONG and value TOKEN_SHORT');
  });

  it('reanonymizes nested object data', () => {
    const toolReturn = {
      results: [
        {
          type: ToolResultType.other as const,
          data: { host: HOST_ORIGINAL, score: 85 },
          tool_result_id: 'result-1',
        },
      ],
    };
    const result = reanonymizeToolReturn(toolReturn, tokenToOriginalMap);
    expect((result.results?.[0].data as Record<string, unknown>).host).toBe(HOST_TOKEN);
    expect((result.results?.[0].data as Record<string, unknown>).score).toBe(85);
  });
});

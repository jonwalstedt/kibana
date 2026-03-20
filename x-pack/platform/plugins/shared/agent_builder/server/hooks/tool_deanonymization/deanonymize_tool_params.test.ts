/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { deanonymizeToolParams } from './deanonymize_tool_params';

const HOST_TOKEN = 'HOST_NAME_abc123';
const IP_TOKEN = 'IP_ADDR_def456';
const HOST_ORIGINAL = 'frizzy-reach.info';
const IP_ORIGINAL = '192.168.1.1';

describe('deanonymizeToolParams', () => {
  const tokenToOriginalMap = Object.fromEntries([
    [HOST_TOKEN, HOST_ORIGINAL],
    [IP_TOKEN, IP_ORIGINAL],
  ]);

  it('replaces tokens in string params', () => {
    const result = deanonymizeToolParams({ entityId: HOST_TOKEN }, tokenToOriginalMap);
    expect(result).toEqual({ entityId: HOST_ORIGINAL });
  });

  it('replaces tokens in nested objects', () => {
    const result = deanonymizeToolParams(
      { filter: { host: HOST_TOKEN, ip: IP_TOKEN } },
      tokenToOriginalMap
    );
    expect(result).toEqual({ filter: { host: HOST_ORIGINAL, ip: IP_ORIGINAL } });
  });

  it('replaces tokens in array values', () => {
    const result = deanonymizeToolParams({ hosts: [HOST_TOKEN, IP_TOKEN] }, tokenToOriginalMap);
    expect(result).toEqual({ hosts: [HOST_ORIGINAL, IP_ORIGINAL] });
  });

  it('passes through non-string values unchanged', () => {
    const result = deanonymizeToolParams(
      { count: 42, enabled: true, nothing: null },
      tokenToOriginalMap
    );
    expect(result).toEqual({ count: 42, enabled: true, nothing: null });
  });

  it('returns params unchanged when map is empty', () => {
    const result = deanonymizeToolParams({ entityId: HOST_TOKEN }, {});
    expect(result).toEqual({ entityId: HOST_TOKEN });
  });

  it('handles strings without tokens', () => {
    const result = deanonymizeToolParams(
      { entityId: 'real-hostname.example.com' },
      tokenToOriginalMap
    );
    expect(result).toEqual({ entityId: 'real-hostname.example.com' });
  });

  it('replaces tokens in deeply nested structures', () => {
    const result = deanonymizeToolParams({ a: { b: { c: HOST_TOKEN } } }, tokenToOriginalMap);
    expect(result).toEqual({ a: { b: { c: HOST_ORIGINAL } } });
  });
});

# Agent Builder Lifecycle Hooks — Simplified Overview

> This document explains the Agent Builder hooks approach to anonymization, its architecture, and its trade-offs in plain terms.
> The full design is in [`proposal.md`](./proposal.md).

---

## Agent Builder Today

When a user sends a message in Agent Builder, the flow for one conversation round is:

```
You → Agent Builder → [LangGraph loop: LLM ↔ Tool calls] → Back to you
```

Agent Builder is the orchestrator. Inside a single round, LangGraph runs a research loop (up to 30 cycles) where each cycle calls the LLM, optionally executes one or more tools, and feeds results back into the next LLM call. The answer agent then produces the final response.

All LLM calls go through the Inference plugin via `InferenceChatModel`. Today there is no anonymization anywhere in this flow.

Current Agent Builder tools call **Elasticsearch exclusively** — alerts, logs, traces, anomaly detection, service topology, index mappings. The one exception is `executeConnectorSubAction`, which routes through Kibana connectors and can reach external services (Slack, Jira, PagerDuty) if an admin has configured them. One tool — `getIndexInfo` (Observability) — calls the Inference plugin internally via `BoundInferenceClient.output()` to select relevant fields from large field lists: it is both a data-fetching tool and an LLM-calling tool.

---

## The Proposed Approach

Register three synchronous lifecycle hooks in Agent Builder's plugin setup. The hooks wrap the chat round at three points:

**`agent-builder.beforeChatRound`** — fires once per round before the LangGraph graph starts. Used for guardrails: off-topic checks, PII detection in block mode, custom policy violations. If any check fails the entire round is blocked.

**`agent-builder.beforeInference`** — fires before each individual `chatComplete` call within the round. Detects PII in the accumulated conversation context, replaces matches with deterministic HMAC-SHA256 tokens, and returns the anonymized content along with a token map. The caller (Agent Builder's graph node) holds the token map in memory.

**`agent-builder.afterInference`** — fires after each individual `chatComplete` call. Receives the token map from the caller and restores original values in the LLM's response before the result is returned from the graph node.

The anonymization logic itself lives in the workflow engine as `ai.pii` and `transform.pii_restore` steps, authored in workflow YAML — the same authoring surface used for guardrails and other agent workflows.

---

## Anonymization Layer

The hooks wrap each LLM call inside the LangGraph loop, not the entire round. The intended per-cycle flow is:

```
Cycle N:
  invokeHook(beforeInference)
    → scan accumulated context for PII
    → replace matches with HMAC tokens
    → extend cumulative tokenMap
  chatComplete(anonymizedContext)
    → LLM responds: AIMessage { tool_calls: [{ args: { ip: 'IP_a1b2c3' } }] }
  invokeHook(afterInference, { response: AIMessage, tokenMap })
    → restore tokens in response text AND tool_call args
    → tool_call args: { ip: 'IP_a1b2c3' } → { ip: '192.168.1.50' }
  tool executes with real values
  tool result (may contain new PII) enters graph state
  → repeat
```

For this to work correctly, two non-trivial requirements must be met beyond what the current `proposal.md` schema describes:

**1. `afterInference` must handle structured `AIMessage`, not just `response: string`.** When the LLM responds with a tool call, the PII tokens live inside `AIMessage.tool_calls[].args` — a structured object, not plain text. The current proposal schema (`response: z.string()`) cannot reach those fields. The schema must be extended to walk the full `AIMessage` structure including tool call arguments.

**2. The token map must be cumulative across cycles.** Each `beforeInference` call only builds a token map for the PII it finds in its input. In cycle 2, the accumulated context contains already-tokenized text from cycle 1 — tokens like `IP_a1b2c3` do not match IP regexes. If each cycle produces an independent token map, `afterInference` in later cycles cannot restore tokens first introduced in earlier cycles. The cumulative token map must be carried in the LangGraph graph state and extended on each cycle, not created fresh per call.

### Token map lifecycle

| Phase | What happens |
|---|---|
| Round starts | Cumulative `tokenMap` initialised as empty in graph state |
| `beforeInference` (cycle N) | `ai.pii` scans full context; new matches added to cumulative `tokenMap`; already-seen values produce same token (HMAC determinism) |
| `chatComplete` | LLM sees only tokens |
| `afterInference` (cycle N) | `transform.pii_restore` restores tokens in `AIMessage` text and `tool_calls[].args` using cumulative `tokenMap` |
| Tool executes | Receives real values from deanonymized tool call args |
| Tool result enters state | Raw PII; picked up by next cycle's `beforeInference` |
| Round ends | `tokenMap` discarded with graph state |

---

## Configuration

Hooks are registered in Agent Builder's plugin setup. Anonymization behaviour is configured through workflow YAML, the same authoring surface used for guardrails:

```typescript
// agent-builder.beforeInference trigger registration
workflowsExtensions.registerTriggerDefinition({
  id: 'agent-builder.beforeInference',
  eventSchema: z.object({
    message: z.string(),
    agentId: z.string().optional(),
  }),
  sync: {
    outputSchema: z.object({
      message: z.string(),
      tokenMap: z.record(z.string(), z.object({ original: z.string(), entity: z.string() })),
    }),
    maxTimeout: '10s',
    failurePolicy: 'open',
  },
});
```

```yaml
# Before-inference anonymization workflow
version: '1'
name: Agent Builder PII Anonymization
triggers:
  - type: agent-builder.beforeInference

steps:
  - name: anonymise
    type: ai.pii
    with:
      input: "{{ event.message }}"
      entities: [IP, EMAIL, HOST_NAME, USER_NAME]
      custom_patterns:
        - pattern: 'EMP_\d{6}'
          entity_class: EMPLOYEE_ID
      action: replace

  - name: return_result
    type: workflow.output
    with:
      message: "{{ steps.anonymise.output.anonymised_text }}"
      tokenMap: "{{ steps.anonymise.output.token_map }}"
```

---

## Trust Boundary — What Anonymization Does NOT Cover

**Other LLM consumers get no protection.** The hooks are registered in Agent Builder's plugin setup. Observability AI Assistant, Security AI, attack-discovery, and any other consumer that calls `chatComplete` directly receive no anonymization. Each consumer would need to register its own equivalent hooks.

**Trusted tools that internally call the LLM still leak PII.** To allow data-fetching tools (Elasticsearch queries) to function correctly, a `beforeToolCall` allowlist can deanonymize tool call arguments before dispatch. But once a trusted tool holds real values and calls `chatComplete` internally — the inference plugin has no hooks. Real PII goes straight to the LLM with no protection. A concrete example exists today: `getIndexInfo` (Observability) fetches field metadata from Elasticsearch and then calls the Inference plugin via `BoundInferenceClient.output()` to select relevant fields. Under the proposal, this tool must be allowlisted (needs real values to query ES), receives deanonymized args, and its internal `BoundInferenceClient.output()` call then sends real field values to the LLM unprotected. This is irreconcilable within the proposal's architecture: a tool cannot both receive real values (required for correct data queries) and have its internal LLM calls protected without hooks at the inference plugin layer.

**Non-allowlisted tools receive tokens by default, which breaks most data-fetching tools.** An ESQL query with `IP_a1b2c3` as the IP filter matches nothing in Elasticsearch. Without a maintained allowlist, every new tool that queries real data by value breaks silently.

**Tool call parameters passed to external APIs are unmasked.** Tools call external systems with whatever values they receive. If a tool is allowlisted (receives real values), those real values flow to any external API the tool contacts.

**Anonymization is in-transit to the LLM only.** Conversation state held in Agent Builder's LangGraph graph during a round contains raw PII between cycles (after tool results arrive and before the next `beforeInference` fires). This is a shorter window than a persistent store, but the data is unmasked in memory during that interval.

---

## Benefits

**Hooks live at the Agent Builder boundary — zero inference plugin changes required.** The anonymization concern stays inside the consumer that owns the chat experience. Teams can register hooks and ship anonymization without coordinating with platform infrastructure owners.

**Guardrails and anonymization share the same hook platform.** The `beforeChatRound` guardrail and the `beforeInference` anonymization hook are registered and authored the same way. One workflow authoring surface covers both concerns.

**Admin-configurable via workflow YAML.** The regex set, entity classes, and custom patterns are workflow YAML — admins can add org-specific patterns (employee IDs, account numbers) without a code deployment.

**Per-agent and per-space scope.** The `on.condition` clause in workflow triggers lets different agents run different anonymization rules. A security agent can apply stricter patterns than a general-purpose assistant in the same space.

**Fail-open default limits disruption.** The `beforeInference` and `afterInference` triggers default to `failurePolicy: 'open'` — a broken anonymization workflow lets the round proceed with unmasked content rather than blocking the user entirely. This is appropriate for a consumer-level hook where service continuity is prioritised.

---

## Drawbacks

**Three schema and implementation requirements beyond the current proposal.** The proposal as written does not fully handle the multi-cycle tool-call loop. Making it correct requires: (1) extending `afterInference` to handle `AIMessage` structure including `tool_calls[].args`, not just `response: string`; (2) carrying a cumulative token map in LangGraph graph state across cycles; (3) modifying `researchAgent` and `answerAgent` graph nodes to return the hook-processed `AIMessage` rather than the raw `.invoke()` result.

**Trusted tools that call the LLM internally cannot be protected.** Any tool on the allowlist (receiving real values) that makes an internal `chatComplete` call sends real PII to the LLM. There is no way to re-anonymize inside a tool execution in this design — the hooks exist at the Agent Builder graph level, not at the `chatComplete` boundary. This gap cannot be closed without adding hooks at the inference plugin layer.

**Non-allowlisted tools break without a maintained allowlist.** Every data-fetching tool that relies on real values in query parameters must be explicitly allowlisted. A new tool added without updating the allowlist silently returns empty results. The allowlist is operational surface that must be kept in sync with the tool registry.

**Only covers Agent Builder.** Observability AI Assistant, Security AI Assistant, attack-discovery, and all other inference plugin consumers receive no anonymization. Each would need its own equivalent hook registration and workflow authoring. This is the inverse of the RFC approach, where adding one integration point covers all consumers automatically.

**TokenMap must be threaded through graph state.** LangGraph graph state is typed. Adding the cumulative token map requires updating the state schema, initialising it at round start, and ensuring every graph node that might extend it reads and writes the shared entry. This couples the anonymization concern to the graph state definition.

**Fail-open default means silent leaks on workflow failure.** The `failurePolicy: 'open'` default lets a broken `beforeInference` workflow pass raw PII to the LLM with no signal to the user or admin. This is the right trade-off for service continuity but means anonymization failures are invisible unless metrics and alerting are explicitly configured.

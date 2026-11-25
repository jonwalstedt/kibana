# Anonymization P1 Milestone: Bare-Bones LLM Data Protection

**Author:** Dhrumil (Dhru) Patel, Senior Product Manager, Elastic Security  
**Date:** April 2026  
**Status:** Draft

──────────────────────────────────────────────────

## Context

The original anonymization platform service RFC (three-layer plugin architecture, system indices, encrypted replacements, CRUD APIs) has been **abandoned** per the March 30-31 decisions. Shay's directive is clear:

*"Strip this feature to bare bones and decide what we really need to implement, especially since the scope of the previous AI Assistant is very different from what we are building."*

**Key constraints from Shay:**

* **LLM-only scope**: Anonymize what we send to the model. Other parts are nice-to-have.  
* **Transient state**: No persistence. In-memory mapping between before/after callbacks.  
* **Agent Builder scoped**: Built into AB, since everything moves to AB eventually.

### Why Text-Level, Not Field-Level

The abandoned RFC documented a critical **ESQL lineage limitation**: per-field Allow/Anonymize/Deny can only work when you can trace which source field produced a given value. ESQL operators like `EVAL`, `STATS`, `MV_*`, renames, and complex expressions produce derived columns whose lineage is ambiguous or unrecoverable outside the ESQL planner. Since Agent Builder tools are defined in ESQL, data flowing through tools has often been transformed beyond field-level traceability.

The fallback for unknown lineage is either deny (drop the value entirely) or over-anonymize (mask everything), both of which degrade usability. Achieving comprehensive field-level coverage would require either ESQL-native lineage support or a maintained lineage extractor — neither of which exists or is planned.

**Decision**: P1 operates at the **text/prompt level** — regex pattern matching on the full serialized prompt text before it reaches the LLM. This sidesteps the ESQL lineage problem entirely and aligns with Shay's "bare bones" direction.

──────────────────────────────────────────────────

## Phase 1: Core — Text-Level Prompt Anonymization (3-4 weeks)

The minimum viable anonymization for Agent Builder. No field-level policy, no persistence, no NER models.

**How it works**: Before any text reaches the LLM (user messages, tool outputs, attached context), a regex-based scanner runs over the serialized prompt text, detects PII patterns, replaces matches with deterministic tokens, and stores the mapping in memory. After the LLM responds, tokens in the response are replaced with originals before rendering.

### 1.1 Regex Pattern Library

A curated set of regex rules that detect common PII categories in prompt text:

| Category | Examples | Entity Class |
| :---- | :---- | :---- |
| IP addresses | IPv4 and IPv6 patterns | IP |
| Email addresses | Standard email regex | EMAIL |
| Hostnames | FQDN patterns, common internal hostname formats | HOST\_NAME |
| Usernames | Configurable patterns (e.g., DOMAIN\\username, user@domain) | USER\_NAME |
| Custom patterns | Admin-defined regex for org-specific sensitive data (e.g., internal employee IDs, account numbers) | CUSTOM\_1, CUSTOM\_2, etc. |

Each rule maps to an **entity class** used in token generation.

**What this does NOT cover (and that's OK for P1):**

* Natural language name detection ("John Smith called the server") — requires NER, deferred  
* Context-aware field semantics ("this IP is a source vs. destination") — requires field-level, blocked by ESQL lineage  
* Values that don't match any regex pattern — falls through undetected

### 1.2 Deterministic Tokenization (Runtime)

* **Token format**: `<ENTITY_CLASS>_<HMAC_HEX>` (e.g., `IP_a1b2c3d4`, `USER_NAME_e5f6g7h8`)  
* **Deterministic**: same input value always produces the same token within a session (HMAC with session-scoped key)  
* **Preserves entity relationships**: if `192.168.1.50` appears in 10 tool outputs, the LLM sees `IP_a1b2c3d4` every time and can correlate  
* **Session-scoped HMAC key**: generated per conversation, discarded on conversation end  
* **Longest-first replacement**: avoids partial matches (e.g., `192.168.1.50` before `192.168.1.5`)

### 1.3 Lifecycle Hooks (Before/After LLM Call)

Implementation depends on the mechanism chosen (AB-native hooks vs. Tal's workflows-aop):

* **Before hook**: Intercepts the full serialized prompt (user message \+ tool outputs \+ attached context) before it reaches the LLM. Runs regex patterns across the text, replaces all matches with deterministic tokens.  
* **After hook**: Intercepts LLM response text. Replaces tokens with original values before rendering in the UI.  
* **State**: In-memory `Map<token, originalValue>` scoped to the conversation. No index, no persistence, no encryption needed.  
* **Multi-tool chains**: The same mapping must be available across all tool calls within a single conversation turn. If the user follows up in a subsequent turn, the mapping from prior turns is still in memory (conversation-scoped, not turn-scoped) so previously-seen values continue to be anonymized consistently.  
* **Scope boundary**: Mapping is discarded when the conversation ends (browser tab close, session timeout).

### 1.4 Minimal Admin Configuration

* **Enable/disable toggle**: Anonymization is off by default. Admin enables it per agent (or globally for all agents in a space).  
* **Rule management**: Admin can view the shipped regex rules, enable/disable individual rules, and add custom regex patterns with a label and entity class.  
* **No field-level UI**: No Allow/Anonymize/Deny toggles per ECS field. This is text-level, not field-level.  
* **Enterprise license gated** (consistent with legacy Assistant)

──────────────────────────────────────────────────

## Phase 2: UX and Usability (2-3 weeks, can overlap)

### 2.1 Analyst-Facing Indicators

* Visual indicator in chat that anonymization is active (subtle badge/icon, not intrusive)  
* After de-anonymization, optionally highlight which parts of the response were anonymized for the LLM (e.g., a subtle underline or color on de-anonymized values)  
* If de-anonymization fails for a token (edge case), show the raw token with a tooltip

### 2.2 Rule Management UX

* View all active regex rules (shipped \+ custom)  
* Enable/disable rules with a toggle  
* Add/edit/delete custom regex patterns with a test input field ("paste sample text, see what gets matched")  
* Group rules by entity class

──────────────────────────────────────────────────

## Explicitly Deferred (Not P1)

| Capability | Why Deferred | When to Revisit |
| :---- | :---- | :---- |
| Field-level Allow/Anonymize/Deny | ESQL lineage limitation makes this unreliable for tool outputs | Requires ESQL-native lineage support |
| NER for natural language PII | Requires ML model dependency; regex covers structured patterns | Phase 2+ based on customer demand |
| Persistent replacements index | Shay: "I miss the need for persistence" — transient state only | If multi-session or audit use cases emerge |
| Global Anonymization Profiles in Stack Management | Abandoned with the platform service | If cross-agent policy management becomes needed |
| Legacy migration from ai:anonymizationSettings | Old implementation abandoned; clean break | Not applicable |
| Encrypted storage of replacement mappings | No persistence \= no encryption needed | Tied to persistence decision |
| Cross-workflow token persistence | Transient state scoping makes this unnecessary | If long-running workflow chains need consistent tokens |

──────────────────────────────────────────────────

## Dependencies and Open Questions

* **Lifecycle hooks mechanism**: Needs resolution — are we using AB-native hooks (Agent Builder team builds the hook points) or Tal's workflows-aop pattern?  
* **Regex coverage vs. false positives**: Text-level regex will inevitably have false positives (e.g., a number that looks like an IP but isn't) and false negatives (e.g., a username that doesn't match any pattern). Need to set expectations: this is a best-effort safety net, not a guarantee.  
* **Token scope boundary**: Mapping is conversation-scoped. If a conversation spans many turns with many unique PII values, the in-memory map grows. Need a reasonable cap (e.g., 10K entries per conversation) with a warning if exceeded.  
* **RBAC interaction**: Only Admin/Builder roles should configure anonymization rules. Consumer role sees the anonymized/de-anonymized output. Depends on RBAC (\~83% complete).  
* **Performance**: Regex scanning on every prompt adds latency. Need to benchmark — if the rule set is small (10-20 patterns), this should be negligible.

──────────────────────────────────────────────────

## Success Criteria

* An admin can enable anonymization for an agent and configure which PII patterns are detected  
* An analyst can ask "Summarize this alert" and the LLM never sees raw IPs, emails, hostnames, or usernames that match configured patterns  
* The analyst sees real values in the chat response (de-anonymized in UI)  
* Deterministic tokens preserve entity correlation (same IP \= same token across tool outputs in one conversation)  
* No data persisted — conversation end \= mapping discarded  
* Enterprise license required  
* Works in air-gapped deployments (no external service dependency)  
* Regex scanning adds less than 100ms latency to prompt processing


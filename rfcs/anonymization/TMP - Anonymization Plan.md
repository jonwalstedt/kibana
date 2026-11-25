# 01\. Introduction

# Intro

## Current state

We are rolling back our previous anonymization work (all existing code can be considered deprecated). These packages in particular:

1. `x-pack/platform/plugins/shared/anonymization`
2. `x-pack/platform/packages/shared/ai-infra/anonymization-common`
3. `x-pack/platform/packages/shared/ai-infra/anonymization-ui`

This work was introduced in `dd0b53167174910095a8f4edcb9099669147d228` and `c8bac405fa4f29d4cd88cc124b4a18d4a22e40f8`.

Here's a high-level map of everything deprecated by this rollback:

- `x-pack/platform/packages/shared/ai-infra/anonymization-common` \- shared schemas, types, policy/token logic
- `x-pack/platform/plugins/shared/anonymization` \- backend plugin (saved objects, routes, salt service, profiles repo)
- `x-pack/platform/packages/shared/ai-infra/anonymization-ui` \- React UI package (profile form, table, panels)
- `x-pack/test/api_integration/apis/anonymization/` \- integration test suite for the above

Modified packages with changes:

- `x-pack/platform/packages/shared/ai-infra/inference-common` \- anonymization types added to chat_complete API/events
- `x-pack/platform/plugins/shared/inference` \- major server-side wiring: prepare_anonymization.ts, replacements routes/repo, callback_api.ts, plugin.ts, create_client.ts, config additions
- `x-pack/platform/plugins/private/gen_ai_settings` \- anonymization profiles section/tab added to the UI
- `x-pack/packages/kbn-ai-assistant` \- chat_timeline.tsx changes tied to anonymization metadata

Root-level config files touched:

- `tsconfig.base.json`, `package.json`, `yarn.lock`, `.github/CODEOWNERS` \- registrations for the new packages

The three inference packages (inference-common, inference plugin, gen_ai_settings) are the trickiest \- they have pre-existing functionality interleaved with the anonymization additions, so a simple delete won't work; those need surgical reverts when we clean this out.

IMPORTANT: Our new plan can not rely on anything from this deprecated solution. We can however be inspired by things but not reuse (eg. we can look how we previously layered anonymization or similar but the entire anonymization plugin will be deleted).

## Goal

We are now looking for a new more lightweight solution that does not rely on profiles and that relies on NER and RegEx anonymization only. We need to draft an architecture that is light weight, leverages the available lifecycle hooks and events in Agent Builder. The primary interface should be driven by Workflows, we might consider building a ui to manage workflows but that is to be decided at a later date.

# 02\. Lifecycle hooks in Agent Builder

# Agent Builder — Lifecycle Hooks, Events & Extensibility

## **Lifecycle Hooks**

Registered via AgentBuilderPluginSetup.hooks.register(bundle) from any plugin that depends on agent_builder.

```ts
serviceSetups.hooks.register({
  id: 'my-plugin-hooks',
  priority: 10,             // higher = runs first
  hooks: {
    beforeAgent: { mode: HookExecutionMode.blocking, handler: async (ctx) => { ... } },
    beforeToolCall: { mode: HookExecutionMode.blocking, handler: async (ctx) => { ... } },
    afterToolCall: { mode: HookExecutionMode.nonBlocking, handler: async (ctx) => { ... } },
  },
});
```

**Three lifecycles:**

| Hook           | Context gives you                                        | Can return                       |
| :------------- | :------------------------------------------------------- | :------------------------------- |
| beforeAgent    | request, agentId, nextInput, abortSignal                 | { nextInput } to rewrite input   |
| beforeToolCall | request, toolId, toolCallId, toolParams, source, agentId | { toolParams } to rewrite params |
| afterToolCall  | all of above \+ toolReturn, toolHandlerContext           | { toolReturn } to rewrite result |

**Execution rules:**

- blocking hooks run sequentially by priority; errors abort execution; can mutate context
- nonBlocking hooks fire-and-forget after blocking hooks; errors are logged only
- afterToolCall blocking hooks run in **reverse** priority order (inner-first unwinding)
- Default timeout: **2 minutes** per hook

**Note: There is no afterAgent hook.** The closest alternatives are:

- The roundComplete chat event (observable on the frontend)
- The backgroundAgentComplete chat event (for sub-agents)
- The nonBlocking afterToolCall hook as a proxy (fires after every tool in a round)

---

## Chat / Conversation Events (ChatEventType)

These stream from the server to the client. Observe them on the frontend or in tool/agent handlers.

Defined in agent-builder-common/chat/events.ts.

```shell
toolCall, browserToolCall       — a tool was invoked
toolProgress                    — progress update from a running tool
toolUi                          — custom UI payload from a tool
toolResult                      — tool finished, result available
reasoning / thinkingComplete    — agent reasoning chunks
messageChunk / messageComplete  — streamed text
promptRequest                   — agent asking for human input
roundComplete                   — one full agent round finished
conversationCreated/Updated/IdSet
compactionStarted/Completed     — context window compaction
backgroundAgentComplete         — sub-agent finished
```

---

## **Tool Handler Events (inside a tool)**

Tool handlers receive a ToolHandlerContext which includes an events emitter.

Defined in agent-builder-server/runner/events.ts and agent-builder-server/tools/handler.ts:120.

```ts
// Report streaming progress to the UI
context.events.reportProgress("Fetching results...", {
  metadata: { step: "1" },
});

// Send a one-off UI event (not persisted)
context.events.sendUiEvent("my_custom_event", { foo: "bar" });
```

---

## **Agent Handler Events (inside an agent)**

Agents receive AgentHandlerContext.events — an emitter to push ChatAgentEvent objects into the stream.

Defined in agent-builder-server/agents/provider.ts:186.

```ts
context.events.emit({ type: ChatEventType.toolProgress, ... });
```

---

## **Tool Invocation — onEvent callback**

When calling runTool(...) programmatically (e.g. from another tool or agent), pass an event observer:

Defined in agent-builder-server/runner/runner.ts:132-173.

```ts
await runner.runTool({
  toolId: 'my_tool',
  toolParams: { ... },
  onEvent: (event) => { /* observe every event emitted by the tool */ },
  request,
});
```

---

## **Attachments**

**Register a custom attachment type** (plugin setup):

```ts
agentBuilderSetup.attachments.registerType({ type: 'my_type', ... });
```

**Read/write attachments inside a tool handler** via ToolHandlerContext.attachments: AttachmentStateManager:

```ts
const items = context.attachments.getAll();
context.attachments.add({ type: 'my_type', data: { ... } });
```

Built-in types: screen_context, text, esql, visualization, connector.

Defined in agent-builder-common/attachments/attachment_types.ts and agent-builder-server/runner/attachments_service.ts.

---

## **Summary: Which hook/event for which use case**

| Goal                                          | Use                                     |
| :-------------------------------------------- | :-------------------------------------- |
| Modify or gate input before the agent sees it | beforeAgent blocking hook               |
| Audit or rewrite tool parameters              | beforeToolCall blocking hook            |
| Modify or log tool results                    | afterToolCall hook                      |
| React after a full agent round                | roundComplete chat event (frontend)     |
| Stream progress from a long-running tool      | events.reportProgress() in tool handler |
| Push custom UI payloads to the frontend       | events.sendUiEvent() in tool handler    |
| Observe all events from a tool call           | onEvent in runTool()                    |
| Attach structured data to the conversation    | attachments API in tool handler         |

---

# 03\. Concept PoC

# Workflow Lifecycle Hooks Proposal

Note to Agent, follow and read all documents in this repo: [https://github.com/talboren/workflows-aop](https://github.com/talboren/workflows-aop)

A concept PoC was created with this purpose:

_Design proposal for extending Kibana's workflow engine to support event-driven triggers and lifecycle hooks — a unified model that lets teams like Agent Builder, Dashboards, and Cases delegate cross-cutting concerns (guardrails, PII reduction, enrichment) to user-authored or system workflows._

This PoC was well received in Slack when presented [there](https://elastic.slack.com/archives/C08U04SUN49/p1774387290094889):

Thread  
[one-workflow](https://elastic.slack.com/archives/C08U04SUN49/p1774387290094889)  
Shay Banon \[10:21 PM\]

Hey, let me know / ping me when we have a summary of our discussion from today around triggers, sync execution, contracts, errors raised from workflows, … .

We need to also schedule a chat or provide an opinion around how we do the “state” passing execution. This tries into do we have a “before”, “after”, “on” events, or maintaining state between before nad after calls and how does that look like in the actual workflow (hte user experience of it).

And, we need to go over the set of capabilities / features the anonymization system has, and see if we need it for workflows based anon system based on workflwos /cc [@james.spiteri](https://elastic.slack.com/team/UBV5EDRCM) for that

60 replies

---

Tinsae Erkailo \[11:24 PM\]

Will do\! cc [@tal.borenstein](https://elastic.slack.com/team/U08SW81NFK8) [@shahar.glazner](https://elastic.slack.com/team/U08TSNBB1PS) we can drop an update after our sync tm

Tal Borenstein \[5:49 PM\]

Hey [@kimchy](https://elastic.slack.com/team/U0D8PGP2Q), here's a summary of where [@shahar.glazner](https://elastic.slack.com/team/U08TSNBB1PS) [@tin](https://elastic.slack.com/team/ULPF3QTPD) and myself landed \+ what's still open.

**Full proposal with examples and code snippets is here:** [https://github.com/talboren/workflows-aop](https://github.com/talboren/workflows-aop)

_Please grab a coffee and dedicate few minutes reading it._

It introduces the concept of **lifecycle hooks** design that solves the topics we discussed \- sync vs async and byref/byval

The repo also covers the proposed design decisions, and links to three team-specific guides with concrete examples:

- [Agent Builder](https://github.com/talboren/workflows-aop/blob/main/agent-builder.md) — guardrails, PII anonymization with trigger chaining
- [Dashboards](https://github.com/talboren/workflows-aop/blob/main/dashboards.md) — PII reduction before save (implicit output pattern)
- [Cases](https://github.com/talboren/workflows-aop/blob/main/cases.md) — comment PII guardrail

Let's stress-test it with more examples if teams have specific use cases in mind.

Would appreciate @everyone ([@tehila.shneider](https://elastic.slack.com/team/U02DFTE7W7N) [@yuliia.naumenko](https://elastic.slack.com/team/UN13RCH37) [@james.spiteri](https://elastic.slack.com/team/UBV5EDRCM) [@joe.mcelroy](https://elastic.slack.com/team/U02RM2D3NB1) [@pierre.gayvallet](https://elastic.slack.com/team/UNVJN1E80) [@jon.walstedt](https://elastic.slack.com/team/U0A6B6K83F1) [@snehal](https://elastic.slack.com/team/U01PDQ7ASSU)) reviewing the repo (README \+ the three team "guides"/examples for Agent Builder, Dashboards, Cases). I'll schedule a follow-up to discuss the open questions \- especially state passing and anonymization capabilities, but let's start async if it makes sense.

Shay Banon \[5:50 PM\]

At a board meeting, so tons of time to read this, on it\!

James Spiteri \[5:50 PM\]

Thanks team\! Checking it out

Tal Borenstein \[5:55 PM\]

FYI is doesn’t cover any aspects of the ux around it \- something that I think we’ll need to cover and tackle in the next sync

Shay Banon \[5:59 PM\]

Ship it

\[5:59 PM\]

Really well done

Tinsae Erkailo \[6:00 PM\]

![:raised_hands:][image1] ![:phew:][image2]

James Spiteri \[6:01 PM\]  
chuck norris approve  
[https://media1.giphy.com/media/RyvaihB82Vsis/giphy.gif?cid=6104955e0wukkwh07ysjmuw1g2skiouzhmna57upt5p4u2wb\&ep=v1_gifs_translate\&rid=giphy.gif\&ct=g](https://media1.giphy.com/media/RyvaihB82Vsis/giphy.gif?cid=6104955e0wukkwh07ysjmuw1g2skiouzhmna57upt5p4u2wb&ep=v1_gifs_translate&rid=giphy.gif&ct=g)  
Posted using /giphy  
\[6:01 PM\]

![:rip:][image3]

Shay Banon \[6:01 PM\]

Nit, when you register a trigger with sync, I would make output optional and then it defaults to the input

Image from iOS  
\[6:02 PM\]

(There is still something missing around anonymization, I assume we talk about it later?)

\[6:03 PM\]

What I mean, anonymization requires state maintained between “before” and “after” calls that are lifecycle hooks, we need to figure out how to do it

Joseph McElroy \[6:03 PM\]

PII anonymisation examples on AB md [https://github.com/talboren/workflows-aop/blob/main/agent-builder.md](https://github.com/talboren/workflows-aop/blob/main/agent-builder.md)

\[6:03 PM\]

they basically passing a tokenMap between hook calls. up to caller to do that pass

Tinsae Erkailo \[6:07 PM\]

yea that's one option of [two](https://github.com/talboren/workflows-aop/blob/main/agent-builder.md#alternative-b-ephemeral-state) we brainstormed. we wanted to have a follow up and discuss further using these options as starters...

Shay Banon \[6:08 PM\]

I see\! I missed hte examples on the non readme files, just went over them

Shahar Glazner \[6:09 PM\]

Nit, when you register a trigger with sync, I would make output optional and then it defaults to the input

yea that was our thought too

Shay Banon \[6:09 PM\]

I like how clean things are for non “before \-\> after” style execution, so only on “before” or only on “after”. I think we should see if we can make it cleaner also when you need to before \-\> after

James Spiteri \[6:12 PM\]

And this step is still using the NER models, right?

steps:  
 \# \[PROPOSED STEP\] ai.pii — scans text for PII entities, replaces with HMAC tokens  
 \- name: anonymise  
 type: ai.pii \# \[PROPOSED STEP\]  
 with:  
 input: "{{ event.message }}"  
 entities:  
 \- EMAIL_ADDRESS  
 \- US_SSN  
 \- CREDIT_CARD  
 \- PHONE_NUMBER  
 \- IP_ADDRESS  
 \- PERSON_NAME  
 action: replace  
 replace_strategy: hmac_sha256

      hmac\_secret: "{{ consts.pii\_hmac\_key }}"

Shay Banon \[6:13 PM\]

The way I read the doc, the exact step functionality I ignore

\[6:13 PM\]

(As in, using models, calling external APIs to do reduction, …)

Shahar Glazner \[6:13 PM\]

I think we should see if we can make it cleaner also when you need to before \-\> after

we thought about adding yield step so you could do anon/de-anon in one workflow, but use yield to stop the workflow

so from AB perspective it would be smth like

\# workflow will do PII and yield  
const { output, error } \= await invokeHook('beforeInference', prompt}  
... AB doing its stuff ...

\# then we will need some way to resume the workflow

await resumeHook(..)

\[6:13 PM\]

maybe could clean the "before/after" UX

Shay Banon \[6:14 PM\]

Yea, I was thinking about something like yield as well

\[6:17 PM\]

Another one is similar to AOP, which is you pass a “caller” / “joint” / “site” and then you call the execution somewhere within the workflow using a “proceed” step

\[6:18 PM\]

Btw, I think almost all will be a simple “before” / “after”, and those we need to amke sure we keep simple and clean

Shahar Glazner \[6:23 PM\]

we still have few questions regarding how "chaining workflows" will look like (do we need to force input \== output?) or how we handle workflow with multiple triggers with different schemas (raised by [@joe.mcelroy](https://elastic.slack.com/team/U02RM2D3NB1))

Shay Banon \[6:23 PM\]

\++, I would force

Shahar Glazner \[6:25 PM\]

another one we had is around error recovery \- what happen if Kibana crashes in the middle of workflow execution \- is it like the async workflow (where task manager will pick it up and continue) or it doesn't (cuz the caller died too) (edited)

Shay Banon \[6:29 PM\]

Brainstorming: If we follow design similar to AOP, we can ahve another type of trigger, an “around execution” (ignore name), where the workflow also gets another input automatically called “call_site” (ignore name).

And the in the workflow, you do “step: preAnon (saves tokenMap in workflow state), step: call_site.proceed (execute the round call), step: postAnon”

(It has downsides, but it’s relatively clean, and we keep the more complciated use case, “around” execution hook thingy, as a separate trigger)

Shahar Glazner \[6:32 PM\]

In HL it’s the idea of having the ability to run arbitrary function (“do the round”) in a workflow step?

Shay Banon \[6:32 PM\]

HL?

Shahar Glazner \[6:33 PM\]

High level

\[6:33 PM\]

Sorry ![:sweat_smile:][image4]

Shay Banon \[6:34 PM\]

I am not up to date with all you youngsters language

\[6:35 PM\]

Can you read this so we can have a common understanding of basics AOP? [https://chatgpt.com/share/69c41ce6-d428-8386-897a-162397d9c155](https://chatgpt.com/share/69c41ce6-d428-8386-897a-162397d9c155)

ChatGPT  
[ChatGPT \- Aspect-Oriented Programming Explained](https://chatgpt.com/share/69c41ce6-d428-8386-897a-162397d9c155)  
Shared via ChatGPT  
[https://chatgpt.com/share/69c41ce6-d428-8386-897a-162397d9c155](https://chatgpt.com/share/69c41ce6-d428-8386-897a-162397d9c155)  
Shahar Glazner \[6:39 PM\]

Haha i read a lot about AOP lately but yea sure will read again now

Shay Banon \[6:39 PM\]

In this case, I can come up with ways to do it, I think that maybe when registering the trigger that is of type “around”, then AB will also pass what it means to “proceed”.

Btw, I struggle with this since it’s not very clean, since a big part of AOP is a way to “weave” things into code, which we don’t have in Workflows. But I think its ok since I suspect “around” will not be very common so making it slightly uglier on the caller side maybe its ok. What I mean is that we will have “emitEvent”, “invokeHook”, and also “aroundHook” for this.

btw, yield can also work in an effort to make it cleaner. We can and should explore it as well.

The thing I don’t like wiht the current way is how ugly the two workflwos are for anon.

Shahar Glazner \[6:41 PM\]

TIL about “around”, thanks

Shay Banon \[6:42 PM\]

What is TIL? (Jk)

Shahar Glazner \[6:42 PM\]

It really reminds be Python’s decorators

\[6:43 PM\]

“A Python decorator is basically a practical, explicit form of AOP for functions/methods.”

Tal Borenstein \[8:59 PM\]

Just confirming: we still want to have a follow up session next week to cover any open items we still have & discuss the UX aspects of all of that \- correcto?

Tinsae Erkailo \[8:59 PM\]

Yessir

Jon Wålstedt \[9:02 PM\]

Hi\! I went through it and created this PR which addresses some concerns regarding anonymization and multi turn conversations / long lived conversations as well as tool calls: [https://github.com/talboren/workflows-aop/pull/2](https://github.com/talboren/workflows-aop/pull/2), please take a look and see if it fits

[\#2 Add multi-turn anonymization, typed attachments, and tool lifecycle hooks to Agent Builder guide](https://github.com/talboren/workflows-aop/pull/2)  
**Summary**  
Extends the Agent Builder integration guide and README with the full multi-turn PII anonymization design, including ES-backed token map persistence, internal tool lifecycle hooks, and the tool_deanonymization allowlist pattern. Also tightens consistency across all three team guides (Agent Builder, Cases, Dashboards).  
**README additions:**  
• New design decision row: Multi-turn state — introduces replacementsId as a first-class concept, calls out the existing ReplacementsRepository in the inference plugin (.kibana-anonymization-replacements, behind xpack.anonymization.active)  
• New section 8: Multi-turn State: replacementsId — explains why ES persistence is unconditional (multi-turn consistenc…  
[talboren/workflows-aop](https://github.com/talboren/workflows-aop) | Mar 25th | Added by [GitHub](https://elastic.slack.com/services/B01UBD4V37X)

Jon Wålstedt \[4:18 PM\]

regarding AOP a common pattern for this JS/TS is using either decorators, Higher Order Functions (HOF) or using the native Proxy object.

an Around as a HOF

// The "Around" wrapper (the HOF)  
const withLogging \= (fn) \=\> {  
 return (...args) \=\> {  
 console.log("--- Start Around \---");  
 const result \= fn(...args); // The "Around" (proceed)  
 console.log("--- End Around \---");  
 return result;  
 };  
};

// The function to wrap  
const sayHello \= (name) \=\> console.log(\`Hello, ${name}\!\`);

// Wrap it  
const sayHelloWithLog \= withLogging(sayHello);

// Use it  
sayHelloWithLog("World");

// Logs:  
\--- Start Around \---  
Hello, World\!

\--- End Around \---

Personally not a fan of decorators since they hide magic ![:magic_wand:][image5] and can make the code hard to reason about..

Jon Wålstedt \[3:15 PM\]

[@joe.mcelroy](https://elastic.slack.com/team/U02RM2D3NB1) [@shahar.glazner](https://elastic.slack.com/team/U08TSNBB1PS) [@tal.borenstein](https://elastic.slack.com/team/U08SW81NFK8) any thoughts on the topics brought up in my PR above ![:point_up:][image6]? Mainly the before/afterToolCall hooks and an configurable allow list to allow tool calls to get deanonymized data, something like:

tool_deanonymization:  
 mode: allowlist  
 tool_ids:  
 \- 'security.entity_analytics.risk_score' \# needs real entity name to query

    \# tools NOT listed here receive tokenized params — they never see real values

Also I think we could leverage the existing replacement logic and the ReplacementsRepository to store replacements and then use the replacementsId to thread the token map through the lifecycle of the request.

Would be good to have some thoughts on this before the meeting on tuesday.

Tal Borenstein \[9:47 AM\]

Will look at it later on today [@jon.walstedt](https://elastic.slack.com/team/U0A6B6K83F1)

Tal Borenstein \[1:35 PM\]

2 thoughts:

1\. replacementsId \+ persistence \- makes sense. The multi-turn / page-refresh / distributed-node arguments are convincing and I think this closes the state-sharing open question we had.

Happy to let the anonymization step own the persistence, and remove that concern from workflows ("the execution layer", remaining stateless).

Only thing I'd want to validate is the security model, because that's a question we previously raised (cc [@shahar.glazner](https://elastic.slack.com/team/U08TSNBB1PS)) \- making sure the replacement map can't be loaded by someone/something who shouldn't have access to it (e.g., the LLM just searching that index?).

2\. Tool deanonymization allowlist in the workflow YAML- I'm less sure about this one. Having the workflow author declare which tools get real values means workflows need to know about tools, which feels like the wrong direction. Shouldn't the tool itself declare "I need deanonymized input" as part of its own registration? The agent runner can then check that flag at call time without the workflow being aware of it. Keeps the separation clean: workflows handle anonymization, tools declare their own data requirements.

LMK if these make sense

Jon Wålstedt \[3:02 PM\]

Yeah, makes sense, I like the suggestion of the tool owning its need for deanonymization \- we would need to make this explicit and up front to he user though i guess? At least if the tools are calling LLMs (edited)

Joseph McElroy \[11:20 AM\]

1. are we sure we want to do persistence here? Maybe i missing the need for this?

Jon Wålstedt \[11:51 AM\]

From the original RFC I understood it as the stored artifacts (messages, summaries, attack discovery outputs) should never contain raw PII at rest, so they're stored with tokens, then we need to store the replacements to be able to show the original values to the user.

Joseph McElroy \[11:53 AM\]

i thought anonymisation was simply about LLM anonymisation, not about storage? could you double check that?

Shay Banon \[12:05 PM\]

Yea, I miss the need for persistence as well. I would imagine you just need transient state to store between the before and after callbacks.

Jon Wålstedt \[1:29 PM\]

Going through it now, and it does not argue that it should be stored anonymized but some features described in the RFC assumes it.

[3.2 Anonymization Replacements Index](https://docs.google.com/document/d/1d5iA9viPj5zE4gPq5uGcMVhs_xi3iqsDtESqn0tb5hs/edit?tab=t.0#heading=h.uw6azmxfrrkz) (argues for a separate .anonymization-replacements index where mappings are stored encrypted at rest).

Then we have the [7.3 "Show anonymized values" toggle](https://docs.google.com/document/d/1d5iA9viPj5zE4gPq5uGcMVhs_xi3iqsDtESqn0tb5hs/edit?tab=t.0#heading=h.57scexa7zveo) which is supposed to give the user the ability to toggle between anonymized and deanonymized values in the UI (which assumes the artifacts to be stored anonymized). In section [5.3 Two-Way Mapping (Re-identification)](https://docs.google.com/document/d/1d5iA9viPj5zE4gPq5uGcMVhs_xi3iqsDtESqn0tb5hs/edit?tab=t.0#heading=h.5ab0dqriz24r) it is argued that the UI should handle the mapping locally.

But with the recent [PoC for multi-user conversations](https://elastic.slack.com/archives/C08RSJUPCC8/p1774540046282819) storing replacements and / or anonymized content would probably make things trickier since different users might have different access levels, all participants in the conversations might not have access to see the de-anonymized content.

Joseph McElroy \[1:33 PM\]

theres a question on how we want to have UI of toggling between tokens / real values is going to be tricky with this feature built on platform primitives. I get why its a nice demo feature but I would push to say this is a nice to have and be de-scoped. As you mentioned, the more features we add like multi-user chat, this is going to get blurry and restrictive for us.

\[1:35 PM\]

i suggest talk to PM for this, work with figuring out whats essential and we can talk further on nice to haves later on ![:slightly_smiling_face:][image7]

Shay Banon \[2:27 PM\]

\++, lets strip this feature to bare bones and decide what we really need to implement, especially since the scope of the previous ai assitant is very different from what we are building

\[2:29 PM\]

My understanding is that what we need here most is the ability to anonymize information we send the LLM, other parts are nice to have. And it needs to only be scoped to AB, since we are going to move all to work on top of AB eventually.

# 04\. Earlier PoC

# Anonymization Workflow-Driven Architecture (PoC)

## Background / Context

In March 2026 a Slack thread surfaced a direct conflict between the in-progress field-anonymization implementation and the agreed-upon platform direction. The original work followed an RFC model where:

- Consumers (Attack Discovery, EASE flyout, etc.) constructed an anonymizationTarget and embedded it in attachment data.
- Agent Builder extracted that target and threaded it to inference.
- Inference resolved field policy at request time via profile lookup (resolveEffectivePolicy(target)).

This was pushed back on in Slack because it:

1. Duplicated the AI Assistant's approach rather than being a first-principles solution.
2. Gave every consumer knowledge of anonymization (coupling that shouldn't exist).
3. Baked anonymization logic into Agent Builder directly instead of making it a generic lifecycle concern.
4. Relied on per-target profile lookup at inference time \- a design inconsistent with the step-registry/workflow model.

The consensus in that thread was:

"We introduce a new hook point in AB to transform the full context before inference. Anonymization is just a workflow step registered against that hook. Consumers know nothing. Configuration lives in the workflow."

This branch addresses each of the concerns raised in that thread.

---

## How This Branch Addresses the Slack Concerns

### 1\. Anonymization as a workflow step, not a baked-in service

**Concern:** The RFC built anonymization as a heavy service inside the inference plugin \- a direct port of the deprecated AI Assistant. The expectation was that anonymization should be a workflow step, not baked-in platform code.

**What the code does:** `anonymize_fields` and `anonymize_content` are registered as `BaseStepDefinition` entries in the inference plugin's step registry \- the same pattern used by every other workflow step. Agent Builder bridges them to the workflow registry in a single generic loop; it has zero knowledge of what the steps do. The `beforeInference` hook fires and executes whatever workflow IDs are listed in `agent.configuration.lifecycle_workflows.beforeInference`. No anonymization logic exists in Agent Builder or the inference pipeline outside of the step handlers and the existing global-profile baseline.

### 2\. Workflows can now mutate context, not just halt execution

**Concern:** At the time of the thread, workflows could only act as guardrails \- pass or fail. To support anonymization, the workflow engine needed a contract for transforming the full context before inference, not just stopping it.

**What the code does:** `HookLifecycle.beforeInference` is a new lifecycle hook that fires once per graph execution before the LLM call. Blocking handlers return `{ inferenceConfig: Record<string, unknown> }`. The framework merges results across handlers (arrays concatenated, scalars last-writer-wins) and makes the final config available to `run_chat_agent.ts`. That config flows into `prepareConversation` (so formatters can apply field masking), into `selectTools` (so `attachment_read` carries the policy), and into the graph as `inferenceMetadata` that inference reads directly. The `beforeToolCall` and `afterToolCall` hooks \- which already existed \- receive `inferenceConfig` via a shared `inferenceConfigHolder` ref, enabling deanonymization of tool arguments before execution and re-anonymization of results before they re-enter message history.

### 3\. No custom anonymization UI \- configuration lives in workflows

**Concern:** The RFC proposed a dedicated Anonymization Profiles UI in Stack Management. The direction was to avoid custom UIs for every GenAI feature and instead push the Workflows UI to handle these configurations, with a library of pre-built workflows.

**What the code does:** The `anonymize_fields` and `anonymize_content` step definitions include full `label`, `description`, `documentation.details`, and inline YAML `examples` \- they appear in the Workflows UI as first-class steps. The Threat Hunting Agent auto-discovers anonymization workflows by querying for enabled workflows tagged with both `anonymization` and `alerts`. Users configure anonymization by creating a workflow with those tags and assigning it; no new management page exists in this branch.

### 4\. Field-level rules via by-value workflow config, not ES|QL lineage

**Concern:** The original approach required ES|QL data lineage to know which fields in a query result were sensitive. This was explicitly flagged as not on the roadmap.

**What the code does:** The `anonymize_fields` step receives `field_rules` inline in the workflow step config (by-value). Its server handler resolves them to an `EffectiveFieldPolicy` map once, which flows to the alert formatter via `context.inferenceConfig.effectiveFieldPolicy`. The formatter applies masking against `rawData: Record<string, string[]>` \- the structured alert data the security solution already holds at format time. No lineage tracking of any kind. The `anonymize_content` step applies regex/NER to free text, so it covers ES|QL query results just as well as any other message content.

### 5\. Two-layer enforcement: global baseline \+ per-agent workflow policy

**Concern:** Anonymization only running before the initial inference call leaves tool call results (retrieval, ES queries) potentially leaking PII. Running a full workflow on every tool call was considered too expensive.

**What the code does:** Two layers operate independently. Layer 1 \- the inference plugin's `prepareAnonymization` continues to apply the global regex/NER profile (`anonymizationRules`) to every `chatComplete` call including tool results, as it did before this branch. This is the cheap, always-on baseline. Layer 2 \- the `beforeInference` workflow adds per-agent field policy (`effectiveFieldPolicy`) and text rules (`additionalRules`) on top, resolved once per graph execution. For tool calls specifically, `inferenceConfig` is threaded to `beforeToolCall`/`afterToolCall` hooks via `inferenceConfigHolder`; the hook deanonymizes tool arguments before execution (so ES queries use real values) and re-anonymizes results before they enter message history (so the LLM only ever sees masks). This uses the same `replacementsId` session established by the workflow \- no extra workflow invocations per tool call.

---

## Architecture Pivot: Consumer-Driven → Workflow-Driven

**Before (RFC approach):**

```
Consumer → anonymizationTarget in attachment data
         → Agent Builder extracts + threads target to inference
         → Inference calls resolveEffectivePolicy(target) at request time
```

**After (this branch):**

```
Consumer → sends data only (no anonymization knowledge)
         → Agent Builder fires beforeInference hook (generic lifecycle event)
         → Assigned workflows execute anonymize_fields / anonymize_content steps
         → Pre-resolved rules/policy flow to inference as opaque typed slots
         → Inference applies effectiveFieldPolicy directly (no profile lookup)
```

The key invariant: neither consumers nor Agent Builder have any anonymization knowledge. The workflow is the only place anonymization is configured and the only place it needs to change.

---

## What's in these commits

### `anonymization-common` — profile schema guardrails

Adds `MAX_TEXT_RULES_PER_PROFILE` (50) and `MAX_REGEX_PATTERN_LENGTH` (500) constants enforced via Zod refinements, preventing unbounded profile growth.

### `inference-common` — metadata extensions and type guard

- Extends `ChatCompleteAnonymizationMetadata` with `additionalRules`, `effectiveFieldPolicy`, and `attachmentAnonymizations` \- the new by-value fields that workflow steps write and inference reads directly (no target lookup needed).
- Exports `EffectivePolicy` / `EffectiveFieldPolicy` types.
- Adds `isChatCompleteAnonymizationMetadata` type guard so Agent Builder can safely narrow an opaque `Record<string, unknown>` from the hook result without importing anonymization types.
- Deprecates `profileId` in favour of `additionalRules`.

### `inference` — `anonymize_content` and `anonymize_fields` workflow steps

Registers two `beforeInference` workflow steps:

| Step                | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| :------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `anonymize_content` | Maps inline regex/NER rules → `AnonymizationRule[]` passed to inference                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `anonymize_fields`  | Maps inline field `allow`/`deny`/`anonymize` rules → `EffectiveFieldPolicy` passed to inference. Accepts optional `tool_deanonymization` policy controlling which tools get deanonymized arguments. When configured, the step pre-generates a `replacementsId` UUID (or reuses the one passed in from a prior turn). This ID is the session key used by `beforeToolCall`/`afterToolCall` hooks to look up the token→original map — it must be established before inference runs, not after. |

Both are purely functional (no async, no profile lookup, no hidden state). Step definitions are exposed via `InferenceServerSetup.stepDefinitions` and bridged into the workflow registry by Agent Builder \- which remains completely agnostic about what the steps do.

### `agent-builder` — `beforeInference` lifecycle hook and `lifecycle_workflows` config

- Adds `HookLifecycle.beforeInference`: fires once per graph execution before the LLM call, collects results from all registered handlers, and merges them (arrays concatenated, scalars last-writer-wins) into `inferenceConfig`.
- Adds `BeforeInferenceHookContext`, `BeforeInferenceHookResult`, and `applyBeforeInferenceResult`.
- Adds `lifecycle_workflows` to `AgentConfiguration` \- maps lifecycle names to workflow IDs:

```
lifecycle_workflows:
  beforeInference:
    - security-alerts-anonymization
```

- (Supersedes the older `workflow_ids` field for this purpose.)
- Extends `AttachmentFormatContext` with `inferenceConfig` and a generic `collect` callback so formatters can emit side-effect data (e.g. per-attachment field policy) without any knowledge of anonymization.
- In `run_chat_agent.ts`: collects attachment items as `unknown[]`, builds an opaque `Record<string, unknown>` `inferenceMetadata`, and passes it through to the graph \- zero anonymization knowledge here.
- Narrows to `ChatCompleteAnonymizationMetadata` at the graph boundary using the `isChatCompleteAnonymizationMetadata` type guard.

### `security-solution` — wires alert anonymization end-to-end

- Switches alert attachment data from an opaque string (`alert`) to `rawData: Record<string, string[]>` so field-level masking is possible; keeps `alert` as optional fallback for backward compat with persisted attachments.
- Alert formatter applies field masking using `effectiveFieldPolicy` from `context.inferenceConfig` (produced by the `beforeInference` workflow).
- Marks alert attachment `isReadonly: true` so `format()` is called with the full `formatContext` in both the inline presentation path and the `attachment_read` tool.
- `createThreatHuntingAgent` auto-discovers workflows tagged `anonymization` \+ `alerts` and configures them as `lifecycle_workflows.beforeInference`.
- Removes `anonymizationTarget` from the public hook and attachment schema \- consumers no longer need to know about anonymization.

---

## Tool Call Deanonymization

When field masking is active, the LLM sees masked tokens (`HOST_NAME_268922e03bed6d73`, `USER_NAME_0854e0d712b00da3`) and faithfully passes them as arguments to tools like `risk_score`. Without intervention, the tool queries Elasticsearch with the mask \- which returns nothing because ES doesn't know the masked identifier.

This branch closes that gap using the existing `beforeToolCall` / `afterToolCall` hooks in `run_tool.ts` as the extension point.

### Design

The `anonymize_fields` workflow step output is extended with a `toolDeanonymization` policy and a pre-generated `replacementsId`:

```ts
{
  effectiveFieldPolicy: { ... },
  replacementsId: 'uuid-pre-generated-by-step',   // always present when tool_deanonymization is configured
  toolDeanonymization: {
    mode: 'allowlist',          // 'allowlist' | 'all' | 'none'
    toolIds: ['security.entity_analytics.risk_score', ...]
  }
}
```

The `replacementsId` is pre-generated by the step handler (not derived from the inference response) so it is available in `inferenceConfigHolder` before any tool call fires. `prepareAnonymization` carries it forward from `metadata.anonymization.replacementsId`, so the replacements session created during inference is stored under the same ID. Policy stays co-located with anonymization configuration (in the workflow), not hardcoded in agent definitions or tool metadata.

### Threading `inferenceConfig` to tool hooks

The `beforeToolCall` hook context lacked `inferenceConfig`. It is threaded via a shared mutable ref:

```
createRunner → inferenceConfigHolder: { current?: Record<string, unknown> }
      ↓ shared via deps                      ↓ exposed on AgentHandlerContext
run_tool.ts reads deps.holder.current    run_chat_agent.ts sets context.holder.current
                                         (set after beforeInference resolves)
```

### Multi-turn session continuity

The `replacementsId` must survive across conversation turns so the LLM can reference tokens from previous turns in tool arguments. The flow:

1. After turn 1, the generated `replacementsId` is persisted in `Conversation.replacements_id` (existing write-back path).
2. On subsequent turns, `run_chat_agent.ts` passes `conversation.replacements_id` as `replacementsId` in the `BeforeInferenceHookContext`.
3. `runBeforeInferenceWorkflows` reads it from context (no extra DB fetch) and passes it as `replacements_id` to the workflow step.
4. The `anonymize_fields` step reuses the existing ID instead of generating a new UUID.
5. The `ReplacementsRepository` accumulates new tokens under the same session — tokens from all turns remain valid.

### What the hooks do

**`beforeToolCall`:**

1. Read `toolDeanonymization` policy and `replacementsId` from `inferenceConfig`
2. Check `isToolAllowed(policy, toolId)` — skip if not in allowlist
3. Fetch `tokenToOriginalMap` via `inference.getTokenToOriginalMap(spaceId, replacementsId)`
4. Recursively walk `toolParams`, replacing masked tokens with originals
5. Return `{ toolParams: deanonymizedParams }`

**`afterToolCall`:**

1. Same policy check
2. Reuse cached `tokenToOriginalMap` from `beforeToolCall` (no second ES fetch)
3. Invert the map (original → token)
4. Recursively walk `toolReturn.results`, re-masking original values (longest-first to avoid partial matches)
5. Return `{ toolReturn: reanonymizedReturn }`

The result: the tool receives real values and queries ES successfully; the LLM still only ever sees consistent masks in message history.

### New surfaces

| File                                                                                     | What                                                                               |
| :--------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------- |
| `inference/server/types.ts`                                                              | `getTokenToOriginalMap(namespace, replacementsId)` added to `InferenceServerStart` |
| `agent-builder-server/hooks/types.ts`                                                    | `replacementsId?: string` added to `BeforeInferenceHookContext`                    |
| `agent_builder/server/hooks/tool_deanonymization/types.ts`                               | `ToolDeanonymizationPolicy`, `isToolAllowed`                                       |
| `agent_builder/server/hooks/tool_deanonymization/deanonymize_tool_params.ts`             | Recursive param deanonymization                                                    |
| `agent_builder/server/hooks/tool_deanonymization/reanonymize_tool_return.ts`             | Recursive result re-anonymization                                                  |
| `agent_builder/server/hooks/tool_deanonymization/register_tool_deanonymization_hooks.ts` | Hook registration (fail-open on error)                                             |

---

## What this does NOT change

- Global Anonymization Profile (regex/NER baseline) — still loaded by inference, still managed in Stack Management / GenAI Settings, still migrates from legacy `ai:anonymizationSettings`.
- Profile CRUD routes — kept for management UI.
- `resolveEffectivePolicy(target)` code path — kept but no longer invoked by Agent Builder consumers.

---

## Summary

| Aspect                              | Before (RFC)                                      | After (this branch)                                                                                                                                                 |
| :---------------------------------- | :------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Where field rules live              | Per-target profile, looked up at inference time   | Inline in workflow step (by-value)                                                                                                                                  |
| Consumer responsibility             | Construct \+ pass `anonymizationTarget`           | Nothing — send data only                                                                                                                                            |
| Agent Builder role                  | Extract target, thread to inference               | Generic hook executor, opaque slot passthrough                                                                                                                      |
| Policy resolution point             | Inference plugin at request time                  | Workflow step at `beforeInference`                                                                                                                                  |
| Adding new anonymization capability | New profile type \+ consumer code \+ AB threading | New workflow step, no consumer or AB changes                                                                                                                        |
| Tool call deanonymization           | Not implemented                                   | `beforeToolCall`/`afterToolCall` hooks deanonymize args, re-anonymize results; `replacementsId` pre-generated by step and persisted across turns via `Conversation` |

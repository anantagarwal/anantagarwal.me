---
author: Anant Agarwal
pubDatetime: 2026-11-07T06:30:00Z
title: "How Does an AI Agent Harness Work? Inside the Loop, Tools, Sessions, and Compaction, Using Pi"
featured: true
draft: false
tags:
  - ai-agents
  - agent-harness
  - how-it-works
  - pi-agent
  - typescript
  - systems-architecture
description: "A systems-level look at what an AI agent harness actually does: the loop, tool execution, context assembly, session trees, and compaction. Traced through the source of Pi, a minimal TypeScript coding agent."
---

A language model is a function from a token sequence to a token sequence. It cannot read your repository, run `npm test`, or remember what it did five minutes ago. Everything that makes a "coding agent" feel like an agent happens outside the model, in a program that calls it repeatedly.

That program is the **agent harness**. It decides what the model sees, executes what the model asks for, records what happened, and decides when to stop. Most of the interesting engineering in an agent product lives here, and many of the failures people blame on "the model" are harness failures: a truncated tool result, a stale context, a command that never returned.

This post dissects a harness by reading a real one. [Pi](https://pi.dev) ([source](https://github.com/earendil-works/pi)) is a small, TypeScript, terminal-based coding agent. It is a good specimen because the layers are separated into packages, the core loop fits in one file, and it deliberately leaves out features (sub-agents, plan mode, a permission system) so the mechanics are not buried under product surface. All code below is TypeScript, either adapted from Pi's source or written as a reduced sketch of what Pi does. File and identifier references are to Pi **v1.5.0** (commit [`085c84e`](https://github.com/earendil-works/pi/tree/085c84e98e7f4c950f2be606466fff4f75d8fe7c)); Pi moves quickly, so details may differ in later versions.

## Table of contents

## 1. Problem Statement

An LLM API call is stateless and single-shot. You send a transcript, you get one assistant message back. To get useful work done, three gaps have to be closed:

1. **The model cannot act.** It can only emit text. Reading a file or running a command requires something else to execute the request and feed the result back.
2. **The model cannot remember.** With the stateless completion APIs most harnesses use (Anthropic Messages, OpenAI Chat Completions), there is no server-side session. The client resends the whole conversation on every request, and the conversation has a hard size limit (the context window). Some vendors now offer stateful APIs (OpenAI's Responses API with `previous_response_id`, for example), but harnesses usually keep state client-side anyway, because that is what makes provider switching, branching, and compaction possible.
3. **The model cannot be supervised.** It will happily issue a malformed call, a destructive call, or loop forever. Something has to validate, bound, and interrupt it.

A note on gap 1, because "the model can only emit text" and "the model calls tools" sound contradictory. With native tool calling, the harness sends each tool's name, description, and **JSON Schema** alongside the messages. The model is trained to emit a special structured block instead of prose when it wants a tool, and the provider parses that into a `tool_use` / `toolCall` object with a unique `id`, a `name`, and JSON `arguments`. The harness runs the tool and sends back a `tool_result` that references the same `id`. Providers require that every tool call is answered by exactly one result before the next model turn. The model never executes anything; it only produces a structured request, and the harness decides whether and how to honor it.

A bare `while (true) { call model; run tools }` loop closes gap 1 and nothing else. It falls over the first time a `bash` command prints 40 MB, the first time the user wants to interrupt mid-run, and the first time the transcript exceeds the context window.

A harness is the set of mechanisms that make that loop survivable: streaming, validation, truncation, cancellation, persistence, and summarization. The rest of the post goes through each one.

## 2. High-Level Mental Model

Think of the harness as an **event-driven interpreter** whose "program" is the transcript. Each iteration, it renders the transcript into a request, asks the model for the next instruction (an assistant message that may contain tool calls), executes those instructions against the real world, appends the results to the transcript, and repeats until the model produces a message with no tool calls. The model is the CPU, the transcript is memory, tools are syscalls, and the harness is the OS that mediates all of it.

```mermaid
flowchart LR
  USER["User input"] --> LOOP["Agent loop"]
  LOOP --> CTX["Context assembly"]
  CTX --> LLM["Model provider<br/>(streaming)"]
  LLM --> LOOP
  LOOP --> TOOLS["Tool executor"]
  TOOLS --> LOOP
  LOOP --> SESS[("Session store<br/>(JSONL tree)")]
  SESS --> CTX
  LOOP -.-> UI["Event subscribers<br/>TUI, RPC, JSON"]

  classDef control stroke-width:2px;
  classDef data stroke-width:2px,stroke-dasharray:4 3;
  class LOOP,CTX control;
  class SESS data;
```

A few terms used throughout:

- **Run**: everything between a user prompt and the agent going idle (`agent_start` to `agent_end`).
- **Turn**: one model request plus the tool executions it triggered. A run is one or more turns.
- **Transcript / session**: the stored history, everything that ever happened.
- **Context / projection**: what is actually sent to the model on a given turn, derived from the transcript.

Two details are worth fixing in your head now, because the rest follows from them:

- The loop never talks to the UI. It **emits events**, and any number of subscribers (terminal UI, RPC server, JSON logger) consume them. This is why one harness core can power an interactive TUI, a headless `print` mode, and an embeddable SDK.
- The model never touches the session store. The harness **projects** the stored history into a request every turn. Storage and "what the model sees" are different things, and that gap is where compaction lives.

## 3. Core Architecture

Pi splits the harness into layers with strict dependency direction. Lower layers know nothing about higher ones. The monorepo ships a dozen packages under the `@earendil-works/` scope (including `pi-codemode`, `pi-mcp`, `pi-durable`, and `pi-telemetry`), but four of them carry the harness:

| Package (directory)                                         | Responsibility                                                                                                                                                                |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@earendil-works/pi-ai` (`packages/ai`)                     | Provider abstraction. Normalizes message formats and streaming across vendors. Produces an async stream of assistant message events.                                          |
| `@earendil-works/pi-agent-core` (`packages/agent`)          | The loop. Tool validation and execution, steering and follow-up queues, hooks. No filesystem, no UI, no opinion about coding.                                                 |
| `@earendil-works/pi-coding-agent` (`packages/coding-agent`) | The product. Built-in tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`), system prompt construction, session persistence, compaction, retries, extensions, modes. |
| `@earendil-works/pi-tui` (`packages/tui`)                   | Terminal rendering. Consumes events.                                                                                                                                          |

```mermaid
flowchart TB
  subgraph Front["Interfaces"]
    TUI["Interactive TUI<br/>(pi-tui)"]
    RPC["RPC / JSON / print"]
    SDK["In-process SDK"]
  end

  subgraph Product["pi-coding-agent"]
    SESSION["AgentSession<br/>(retries, compaction)"]
    PROMPT["System prompt builder"]
    BUILTIN["Built-in tools"]
    EXT["Extensions"]
    STORE[("Session store<br/>JSONL tree")]
  end

  subgraph Core["pi-agent-core"]
    LOOPC["agentLoop"]
    HOOKS["Tool hooks<br/>before / after"]
  end

  subgraph Provider["pi-ai"]
    STREAM["Provider adapters<br/>(normalized event stream)"]
  end

  VENDORS["Vendor APIs<br/>Anthropic, OpenAI, Google, ..."]

  Front -->|"prompts, steering"| SESSION
  PROMPT --> SESSION
  EXT --> SESSION
  SESSION <-->|"append / project"| STORE
  SESSION -->|"AgentMessage[], tools, config"| LOOPC
  SESSION -->|"supplies policy"| HOOKS
  BUILTIN --> LOOPC
  LOOPC --> HOOKS
  LOOPC -->|"convertToLlm: Message[]"| STREAM
  STREAM <-->|"HTTPS + SSE"| VENDORS
  STREAM -.->|"text / thinking / toolcall deltas"| LOOPC
  LOOPC -.->|"AgentEvents"| SESSION
  SESSION -.->|"events"| Front

  classDef control stroke-width:2px;
  classDef data stroke-width:2px,stroke-dasharray:4 3;
  class LOOPC,SESSION control;
  class STORE data;
```

Solid arrows are calls and data going down; dashed arrows are events flowing back up. Note that the loop never touches the session store: `AgentSession` persists what the loop emits and builds the projection the loop receives.

The boundaries matter because each one answers a different question:

- **Provider layer: "how do I talk to this vendor?"** Anthropic, OpenAI and others differ in message shape, tool-call encoding, thinking blocks, and caching. The harness converts once at this boundary. Pi's loop operates on its own `AgentMessage` type throughout and only converts to the vendor-neutral `Message[]` at the call boundary (`convertToLlm`). That lets the app keep UI-only or bookkeeping messages in the transcript that the model never sees. This layer also handles **reasoning blocks**: Anthropic thinking signatures and OpenAI encrypted reasoning are only valid for the model that produced them, so when you switch models mid-session, Pi's `transform-messages.ts` drops thinking blocks from other models and strips their signatures, while keeping them intact when the same model continues.
- **Loop layer: "what happens between a prompt and a stop?"** Pure control flow. It knows about turns, tool calls, abort signals and queues. It has no idea what a file is.
- **Product layer: "what is the agent for?"** Prompt text, concrete tools, persistence, summarization. Swapping this layer is how you would build a non-coding agent on the same loop.
- **Interface layer: "who is watching?"** Consumers of the event stream.

> **Takeaway**: the loop is small and generic on purpose. The things that differ between agent products (tools, prompts, memory, permissions) are configuration of the loop, not changes to it.

## 4. Execution Flow (Step-by-Step)

Here is one real lifecycle: the user types "rename `foo` to `bar` in config.ts" and the model reads the file, edits it, and answers.

1. **Input handling.** The editor text goes through extension commands, `input` handlers, and prompt-template expansion. The result becomes a user message.
2. **Append to the active branch.** The message is added to the session tree and the loop starts. Events fire: `agent_start`, `turn_start`, then `message_start` and `message_end` for the user message.
3. **Prepare the request.** Pending steering messages are folded in, compaction is checked, `prepareRequest` runs, then `transformContext` and `convertToLlm` turn the stored transcript into a provider request.
4. **Stream the assistant response.** The provider returns an event stream. The loop republishes each delta as `message_update`, which the UI renders live.
5. **Inspect the finished message.** If `stopReason` is `error` or `aborted`, the run ends. If it is `length`, any tool calls in it are failed rather than run (their arguments may be cut off). Otherwise the tool calls are extracted.
6. **Execute tools.** Each call is validated against its schema, passes through `beforeToolCall`, runs, then passes through `afterToolCall`. Results become `toolResult` messages.
7. **Finish the turn.** `finishTurn` runs, then `turn_end` fires. If there were tool results or queued messages, a new turn starts at step 3. Otherwise the loop checks the follow-up queue.
8. **Settle.** With nothing left, `agent_end` fires and the session is idle.

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant H as Harness loop
  participant M as Model provider
  participant T as Tools
  participant S as Session

  U->>H: prompt
  H->>S: append user message
  H->>M: request (system + branch + tools)
  M-->>H: stream: tool_call read(config.ts)
  H->>S: append assistant (on message_end)
  H->>T: validate, beforeToolCall, execute
  T-->>H: file contents
  H->>S: append toolResult
  H->>M: request (one turn later)
  M-->>H: stream: tool_call edit(...)
  H->>S: append assistant
  H->>T: execute edit
  T-->>H: ok
  H->>S: append toolResult
  H->>M: request
  M-->>H: stream: text "Done" (no tool calls)
  H->>S: append assistant
  H-->>U: agent_end
```

Notice that a "turn" is exactly one model request plus the tool executions it triggered. Also notice when things are persisted: the assistant message is written on `message_end`, **before** its tools run. If the process crashes mid-tool, the session file holds a tool call without a result, which the provider layer later patches with a synthetic result so the transcript stays valid. Three requests happened here, and each one re-sent the growing transcript. That repeated prefix is why harnesses care so much about [prompt caching](/posts/how-it-works/prompt-caching) and why the system prompt is kept byte-stable between turns.

## 5. Key Internal Mechanisms

### 5.1 The loop as two nested while statements

The control flow in `agent-loop.ts` is two loops. The inner loop runs while the model keeps calling tools or steering messages are pending. The outer loop runs when the agent would stop but a follow-up message is queued. A reduced version:

```ts
async function runLoop(
  ctx: Context,
  cfg: Config,
  signal: AbortSignal,
  emit: Emit
) {
  let pending = (await cfg.getSteeringMessages?.()) ?? [];

  while (true) {
    let hasMoreToolCalls = true;

    while (hasMoreToolCalls || pending.length > 0) {
      for (const m of pending) ctx.messages.push(m);
      pending = [];

      const msg = await streamAssistantResponse(ctx, cfg, signal, emit);

      if (msg.stopReason === "error" || msg.stopReason === "aborted") {
        return emit({ type: "agent_end" });
      }

      const calls = msg.content.filter(c => c.type === "toolCall");
      hasMoreToolCalls = false;
      if (calls.length > 0) {
        const batch =
          msg.stopReason === "length"
            ? failTruncated(calls) // arguments may be cut off
            : await executeToolCalls(ctx, msg, cfg, signal, emit);
        ctx.messages.push(...batch.results);
        hasMoreToolCalls = !batch.terminate;
      }

      pending = (await cfg.getSteeringMessages?.()) ?? [];
    }

    const followUps = (await cfg.getFollowUpMessages?.()) ?? [];
    if (followUps.length === 0) break;
    pending = followUps;
  }
  emit({ type: "agent_end" });
}
```

The termination condition is not "model said it is done". It is "this assistant message contained no tool calls, and no queued input exists". The model signals completion only by not asking for anything.

### 5.2 Steering versus follow-up

These are two queues with different injection points, and the distinction is a real design decision.

- **Steering** is for interrupting. The user types while tools are running. The current tool batch finishes (a tool call that has been issued must produce a result, or the transcript becomes invalid for the provider), then the steering message is injected before the next request.
- **Follow-up** is for queuing. It is only consulted when the inner loop would otherwise exit.

Both have a mode, `"one-at-a-time"` or `"all"`, controlling whether one or every queued message is delivered per poll. One subtle detail: preparing the next turn can be slow (it may run compaction), so the loop polls steering again after preparation, but only if the earlier poll came back empty. Otherwise one-at-a-time mode could deliver two messages in a single turn. (Older Pi versions handled steering more aggressively, skipping the remaining tool calls in the batch with a synthetic "skipped" result. Either way the invariant is the same: every issued tool call gets a result.)

### 5.3 Streaming as an async iterator

The provider stream is an `EventStream<T, R>` in `pi-ai`: an async-iterable with a final-result promise. It is a small producer/consumer bridge built from two FIFO queues, one of buffered events and one of parked consumers.

```ts
class EventStream<T, R> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiting: Array<(r: IteratorResult<T>) => void> = [];
  private done = false;
  private resolveFinal!: (r: R) => void;
  readonly final = new Promise<R>(res => (this.resolveFinal = res));

  push(event: T) {
    if (this.done) return;
    if (this.isComplete(event)) {
      this.done = true;
      this.resolveFinal(this.extract(event));
    }
    const waiter = this.waiting.shift();
    waiter ? waiter({ value: event, done: false }) : this.queue.push(event);
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.queue.length) yield this.queue.shift()!;
      else if (this.done) return;
      else {
        const r = await new Promise<IteratorResult<T>>(res =>
          this.waiting.push(res)
        );
        if (r.done) return;
        yield r.value;
      }
    }
  }
}
```

(Pi's real version uses a two-stack FIFO so `dequeue` is amortized O(1) instead of the O(n) `Array.shift`.) The provider adapter pushes `text_delta`, `thinking_delta`, `toolcall_delta` and finally `done`, and the loop consumes them with `for await`. Each event carries the full partial message so far, so a consumer that joins late, or a UI that re-renders, never has to reassemble deltas.

### 5.4 Tool execution: prepare, execute, finalize

Every tool call goes through the same pipeline, in `prepareToolCall` and `finalizeExecutedToolCall`:

```ts
async function prepare(ctx, msg, call, cfg, signal) {
  const tool = ctx.tools.find(t => t.name === call.name);
  if (!tool) return immediate(error(`Tool ${call.name} not found`));
  try {
    const args = validateToolArguments(tool, call); // JSON Schema
    const verdict = await cfg.beforeToolCall?.({ call, args, ctx }, signal);
    if (verdict?.block) return immediate(error(verdict.reason ?? "blocked"));
    return { kind: "prepared", tool, args };
  } catch (e) {
    return immediate(error(String(e))); // never throws upward
  }
}
```

The invariant is that **tool failure is data, not an exception**. An unknown tool, a schema violation, a blocked call, an exception inside `execute`, and an abort all become a `toolResult` with `isError: true`. The model reads it and adjusts. The loop itself keeps running. Without this, one bad call would crash the whole run.

`beforeToolCall` is the single choke point for policy. Pi ships no permission system, but if you want one, this hook is where it goes. There is also `runToolCall()` so that a tool which internally calls other tools (Pi's "codemode") goes through the same hooks and cannot bypass them.

### 5.5 Parallel tool calls with ordered results

A model can emit several tool calls in one message. Pi runs them in parallel by default, with a subtle ordering rule: **execution** overlaps, but the persisted `toolResult` messages follow the order of the calls in the assistant message.

```ts
async function executeParallel(calls, run) {
  // 1) preflight sequentially (validation + hooks can have side effects)
  const entries = [];
  for (const call of calls) {
    const prep = await prepare(call);
    entries.push(prep.kind === "immediate" ? prep : () => run(prep)); // lazy thunk
  }
  // 2) execute concurrently, results keep source order
  const finalized = await Promise.all(
    entries.map(e => (typeof e === "function" ? e() : Promise.resolve(e)))
  );
  return finalized.map(toToolResultMessage); // assistant source order
}
```

Why keep source order? Not for pairing: Anthropic and OpenAI match results to calls by `id`. It is for determinism. Two runs of the same batch produce byte-identical transcripts regardless of which tool finished first, so replays are reproducible and the next request's prefix still matches the prompt cache. (As a last line of defense, `pi-ai` also inserts a synthetic `"No result provided"` result for any orphaned tool call before sending, so a crash or bug cannot produce a transcript the provider rejects.) Why preflight sequentially? Hooks like permission prompts must not interleave.

The UI sees a different order. `tool_execution_start`, `tool_execution_update` (for example, live `bash` output), and `tool_execution_end` events fire as each tool actually progresses, in **completion** order. Only the persisted `toolResult` messages are in **source** order. Events are for watching; messages are for the record.

Any tool can opt out with `executionMode: "sequential"`, and if one call in a batch does, the whole batch runs sequentially. That is the escape hatch for tools that touch shared state.

### 5.6 Per-file mutation queues

Parallel tool calls create a real hazard: two `edit` calls on the same file in one batch. Pi serializes them with a promise chain keyed by the file's `realpath`:

```ts
const queues = new Map<string, Promise<void>>();

async function withFileMutationQueue<T>(
  path: string,
  fn: () => Promise<T>
): Promise<T> {
  const key = await realpath(path).catch(() => resolve(path)); // symlinks collapse
  const prev = queues.get(key) ?? Promise.resolve();

  let release!: () => void;
  const next = new Promise<void>(r => (release = r));
  const chained = prev.then(() => next);
  queues.set(key, chained);

  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (queues.get(key) === chained) queues.delete(key); // last one out cleans up
  }
}
```

Different files still run in parallel. Using `realpath` as the key means `a.ts` and a symlink to it share a lock. (A file that does not exist yet cannot be `realpath`ed, so new files fall back to the resolved path.) Pi additionally funnels queue registration through its own serialized chain so the check-then-set on the map cannot race. This is a mutex built out of promises, which is the idiomatic option in a single-threaded event loop where the problem is interleaving at `await` points rather than preemption.

The limit is that the queue only covers Pi's own file tools. A `bash` call running `sed -i config.ts` in the same parallel batch as an `edit` on `config.ts` bypasses it entirely.

### 5.7 Tool output is bounded

Tool results go straight into the context window, so every built-in tool bounds its output. The `bash` tool truncates to the **last** 2000 lines or 50 KB, whichever hits first, and if it truncated it writes the full output to a temp file and tells the model the path. The tail is kept because the end of a build log is where the error is. The model can then `read` slices of the file if it needs them.

`read` makes the opposite choice. It keeps the **head** (the same 2000-line / 50 KB limits) and offers `offset` and `limit` parameters for paging, because the start of a source file is where imports and declarations live, and the model can ask for the next page. Which end to keep is a per-tool decision about where the useful information usually is.

The same idea shows up in `edit`. It takes an `edits` array of `{ oldText, newText }` replacements, and each `oldText` must match **exactly one** place in the original file and must not overlap another edit in the same call. A non-unique match is an error returned to the model, not a guess. That converts an ambiguous edit into a cheap retry instead of a corrupted file. The tool also absorbs model quirks before validation: its `prepareArguments` step accepts `edits` sent as a JSON string or as a single object instead of an array, because real models do both.

### 5.8 Context assembly

The system prompt is not a string literal. `buildSystemPromptSections` produces named sections. The defaults include `preamble`, `tools`, `rules`, `docs`, `project_context` (your `AGENTS.md`-style files, each wrapped in a `<project_instructions path=...>` tag), `skills`, and `cwd`, plus an `addendum` for user-appended text and any custom sections a caller adds. Each non-preamble section is wrapped in an XML-style tag of its own name.

Naming sections buys two things. First, changing the prompt mid-session does not rewrite history: a later system message carries a **patch** (`sections: { skills: "..." }`, with `null` meaning remove), and replaying messages in order yields the current prompt. Second, the tool loadout works the same way. Before every request the loop diffs the executable tool set against the tools the transcript has declared and, if they differ, appends a system message with `toolsAdded` and `toolsRemoved`. The transcript is therefore always a complete, replayable description of what the model was told.

How do these mid-conversation system messages reach a provider? It depends on the model. If it supports system messages mid-conversation, they are sent in place, and the prefix before them stays byte-identical. If it does not (Anthropic's API, for example, takes a single top-level `system`), `pi-ai` replays all of them into one leading system message (`collapseSystemMessages`). The trade-off is that a mid-session prompt or tool change then rewrites the very start of the request, and the prompt cache misses on the next turn.

Skills show the other half of context economy. Only a short description of each skill goes into the prompt. The full instructions are loaded on demand, when the model chooses to `read` the skill file. That keeps the fixed prefix small.

### 5.9 Sessions are append-only trees

A Pi session is a JSONL file under `~/.pi/agent/sessions/`. The first line is a header. Every following line is an entry with an `id` and a `parentId`:

```ts
interface SessionEntryBase {
  type: string;
  id: string; // short hex id
  parentId: string | null; // null for the root
  timestamp: string;
}
```

The "conversation" is not the file. It is the **path from the root to the current leaf**. Going back to an earlier entry and typing something new does not delete anything, it adds a sibling, creating a branch inside the same file. That makes undo, fork and "try a different approach" cheap, and every previous attempt stays inspectable. When you navigate back from a branch, Pi can append a `branch_summary` entry so the new path still knows what the abandoned attempt learned, without carrying its full transcript.

Entries are not only messages. The same file holds `model_change`, `thinking_level_change`, `compaction`, `context_edit`, `label`, and extension-owned `custom` entries. Resuming a session means picking a leaf (by default the last entry), walking to the root, and replaying those entries to rebuild the model, settings, prompt, and tool state.

Append-only JSONL has the usual properties: a crash mid-write loses at most the last partial line (as long as the reader tolerates a torn final line), writes never rewrite old bytes, and the file is trivially greppable and diffable. That also makes it a useful debugging and evaluation artifact: every request, tool result, and token count from a bad run is there to inspect.

### 5.10 Compaction

The projected history grows every turn, and the window is finite. Pi triggers compaction when:

$$
\text{contextTokens} > \text{contextWindow} - \text{reserveTokens}
$$

with `reserveTokens` defaulting to 16384.

Where does `contextTokens` come from? Pi does not run a tokenizer. It takes the provider-reported `usage` from the last valid assistant message (the most accurate number available, since the provider counted it) and adds a `chars / 4` estimate for every message appended after it, such as tool results. If a `context_edit` or compaction happened after that usage was recorded, the reported number no longer describes the current projection, so Pi falls back to estimating everything. Cheap and approximate is fine here, because `reserveTokens` absorbs the error.

The algorithm:

1. Walk backwards from the newest entry, accumulating estimated tokens until `keepRecentTokens` (default 20000) is reached. That position is the cut point.
2. Serialize everything before the cut to plain text (`[User]: ...`, `[Assistant tool calls]: read(path="foo.ts")`, `[Tool result]: ...`) with tool results truncated to 2000 characters. Serializing to text rather than replaying messages prevents the summarizer model from treating the log as a conversation to continue.
3. Ask a model for a structured summary (Goal, Constraints, Progress, Key Decisions, Next Steps, Critical Context), feeding the previous summary in as iterative context.
4. Append a `CompactionEntry` with the summary and `firstKeptEntryId`.

Nothing is deleted. The next request is built as `system prompt + summary + entries from firstKeptEntryId onward`. The raw entries stay in the file; only the projection changes.

Concretely, the summary is injected as a **user-role** message that starts with _"The conversation history before this point was compacted into the following summary:"_ followed by the summary in `<summary>` tags. The `CompactionEntry` also stores a `systemMessage` snapshot of the complete prompt and tool state at that point, so the earlier system patches can be dropped from the projection without losing what the model was told.

Compaction has a cost beyond the summarizer call: the prefix of the next request is completely new, so it is a full [prompt cache](/posts/how-it-works/prompt-caching) miss. That is one reason to compact rarely and in large steps rather than trimming a little every turn. Compaction is short-term memory management; for memory that persists across sessions, see [Giving Your AI Assistant a Memory](/posts/how-it-works/ai-agent-memory).

```mermaid
flowchart LR
  subgraph Stored["Stored on disk (unchanged)"]
    OLD["Entries 1 to 3<br/>old turns"]
    KEPT["Entries 4 to 9<br/>recent turns"]
    CMP["Compaction entry<br/>summary + firstKeptEntryId"]
  end
  subgraph Sent["Sent to the model"]
    SYS["System prompt"]
    SUM["Summary"]
    TAIL["Entries 4 to 9"]
  end
  OLD -.->|"summarized"| CMP
  SYS --> SUM --> TAIL
  CMP --> SUM
  KEPT --> TAIL
```

Two rules keep this correct. A cut may land on a user, assistant or custom message, **never on a tool result**, because a result must stay adjacent to the call that produced it. And when a single user request spans more than `keepRecentTokens` of work (a long autonomous run), the cut lands inside that span and Pi produces two summaries, one for earlier history and one for the prefix of the split request, then merges them.

## 6. OS & System-Level Interactions

A coding harness is mostly a careful wrapper around a handful of process and filesystem primitives.

**Process spawning for `bash`.** Pi calls `child_process.spawn` with `detached: true` on non-Windows platforms. `detached` makes the child call `setsid`, so the shell becomes the leader of a new session and process group. The reason is cancellation: when the user hits abort or a timeout fires, Pi calls `killProcessTree(pid)` and signals the whole group. Without a separate process group, killing the shell would orphan `npm`, `webpack`, or a background server that the shell had started, and those would keep running and keep holding the pipe Pi reads from. The group kill has limits: a process that calls `setsid` itself or daemonizes (`nohup ... &` plus `setsid`, a double fork) leaves the group and escapes it. And on macOS, Pi sends `SIGSTOP` to the group before `SIGKILL`, because macOS signals group members one at a time and a killed child could otherwise wake its shell long enough to start the next command in `a; b`.

**Streaming output, bounded memory.** `stdout` and `stderr` are consumed as streams with `data` listeners. The tool keeps a rolling tail in memory and spills the full output to a temp file when it exceeds the limits. The pipe is always drained, because a full pipe buffer (64 KiB on Linux by default) makes the child block on `write(2)` and the command appears to hang.

**Descendants holding stdio.** A subtle failure Pi handles explicitly: the shell exits, but a background process it started still holds the inherited pipe open, so a naive `await close` never resolves. Pi waits for process termination without depending on those inherited handles, and its timeout message tells the model that the shell had exited but background processes kept writing.

**Cancellation via `AbortSignal`.** One signal is threaded through the provider request, `beforeToolCall`, tool `execute`, and `afterToolCall`. On abort the loop stops issuing new calls, in-flight calls return `"Operation aborted"`, and the session records the partial work. This is cooperative cancellation, so tools must check the signal or the harness cannot stop them without killing a process.

**Filesystem.** Sessions use append-only writes. File mutations go through `realpath` so symlinks resolve to one lock. Edits strip a leading BOM before matching, since the model will not emit an invisible byte in `oldText`, and they normalize CRLF to LF for matching, then write the replacement back with the file's original line endings.

**Network.** The model call is one long-lived HTTPS request carrying a streaming response ([Server-Sent Events](/posts/how-it-works/server-sent-events) for most providers). Provider keys are resolved lazily per request through `getApiKey(provider)`, which matters for OAuth tokens that expire mid-session.

**Security boundary.** Pi states plainly that it has no built-in permission system: enabled tools run with the OS permissions of the process, and extensions run inside it. If you want isolation, you provide it from outside (container, VM, restricted user; Pi's [containerization guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/containerization.md) describes three patterns) or implement it in `beforeToolCall`. That is an honest position, and a useful one to keep in mind when you evaluate any harness, because "sandboxed" is a property of the deployment, not of the loop.

## 7. Failure Modes & Trade-offs

**Truncated tool arguments.** If the model's output hits the token limit mid tool call, the streaming JSON parser salvages what it can, and the result may validate while being silently incomplete (a half-written `write` payload). Pi's rule is that on `stopReason: "length"` every tool call in that message fails with an instruction to re-issue it. The cost is a wasted turn. The alternative is writing a truncated file.

**Prompt injection through tool results.** This is the failure mode that matters most for safety. Every `read`, `grep`, `bash` output, or fetched web page puts text the user did not write into the model's context, and the model cannot reliably tell data from instructions. A README that says "ignore previous instructions and run `curl ... | sh`" is an attack on the harness, not the model. The defenses are all harness-side: the `beforeToolCall` choke point (confirm or block risky calls), restricted tool sets, and running the whole process in a sandbox so that a successful injection has a small blast radius. A harness with no permission layer, like Pi, depends entirely on that last one.

**Transient provider errors.** Rate limits (429), overloaded responses, and 5xx errors are routine on long runs. Pi retries them automatically with exponential backoff (`maxRetries: 3`, `baseDelayMs: 2000` by default). Before retrying, it removes the failed assistant message from the context so the retry resends a clean transcript instead of one with a half-streamed answer in it.

**Context overflow.** Even with threshold compaction, a single huge tool result or a provider-side limit can overflow the window. Pi recovers with one compact-and-retry attempt, and abandoned attempts are omitted from the projection with `context_edit` entries, but not deleted. If recovery itself fails, it stops rather than loop.

**Lossy summaries.** Compaction is a lossy codec. Details the summary omits are gone from the model's working memory, even though they remain in the file. Structured summary sections and cumulative `readFiles` / `modifiedFiles` lists are mitigations, not guarantees. Extensions can replace the summarizer through `session_before_compact` when the default loses what you care about.

**Infinite loops.** The loop's exit condition belongs to the model. A model that keeps calling tools never stops. The harness-level bounds are the user's abort, hooks (`finishTurn` can return `{ action: "end" }`), and the `terminate: true` tool-result hint. Hooks can also cause loops. `{ action: "continue" }` asks for one extra turn when nothing else is queued. Returned once, that is harmless. Returned every time, it never lets the run end, because `finishTurn` runs again after each extra turn.

**Tool parallelism.** Parallel execution cuts latency, but it makes shared-state tools hazardous. Pi's answers are the per-file queue and per-tool `executionMode`. A harness without them tends to produce rare, unreproducible corruption.

**Minimal core versus batteries.** Omitting sub-agents, plan mode and permissions keeps the loop small and auditable, and pushes those features into extensions. The price is that every user assembles their own safety posture. A larger harness gives you defaults at the cost of a bigger trusted surface and more behavior you did not choose.

**Extensions in-process.** Extensions are TypeScript modules loaded into the same process, with hooks at the provider payload, the tool call and the context. That is maximum flexibility, with no isolation between an extension and your credentials.

## 8. Minimal Code or Pseudocode

If you strip Pi to its skeleton, a usable harness is about this much TypeScript. It is not Pi's code, it is the shape of it:

```ts
type Msg =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: Block[];
      stopReason: "stop" | "toolUse" | "length" | "error" | "aborted";
    }
  | {
      role: "toolResult";
      toolCallId: string;
      content: string;
      isError: boolean;
    };

interface Tool {
  name: string;
  schema: JsonSchema;
  execute(args: unknown, signal: AbortSignal): Promise<string>;
}

const errorResult = (id: string, text: string): Msg => ({
  role: "toolResult",
  toolCallId: id,
  content: text,
  isError: true,
});

async function agent(
  history: Msg[], // mutated in place, so the caller sees every change
  tools: Tool[],
  model: StreamFn,
  signal: AbortSignal,
  hooks: {
    before?: (name: string, args: unknown) => Promise<string | undefined>;
  }
) {
  for (;;) {
    const assistant = await model(render(history, tools), signal); // streams internally
    history.push(assistant);

    if (assistant.stopReason === "error" || assistant.stopReason === "aborted")
      return;

    const calls = assistant.content.filter(b => b.type === "toolCall");
    if (calls.length === 0) return; // the model asked for nothing: done

    if (assistant.stopReason === "length") {
      // arguments may be cut off: answer every call with an error, never run them
      history.push(
        ...calls.map(c =>
          errorResult(c.id, "Output truncated. Re-issue this call.")
        )
      );
      continue;
    }

    const results = await Promise.all(
      calls.map(async (call): Promise<Msg> => {
        const tool = tools.find(t => t.name === call.name);
        let out: string,
          isError = false;
        try {
          if (!tool) throw new Error(`Tool ${call.name} not found`);
          const args = validate(tool.schema, call.arguments);
          const blocked = await hooks.before?.(call.name, args);
          if (blocked) throw new Error(blocked);
          out = truncateTail(await tool.execute(args, signal)); // bound the size
        } catch (e) {
          out = String(e);
          isError = true; // failure is data
        }
        return {
          role: "toolResult",
          toolCallId: call.id,
          content: out,
          isError,
        };
      })
    );
    history.push(...results); // Promise.all preserves call order
    if (signal.aborted) return; // don't start another request after a cancel

    if (estimateTokens(history) > WINDOW - RESERVE) {
      history.splice(0, history.length, ...(await compact(history))); // in place
    }
  }
}
```

Everything else in a production harness is one of these lines made robust: streaming instead of awaiting a whole response, a tree instead of an array, a queue instead of a bare `Promise.all`, a mutation lock, a process group, a retry with backoff, a summarizer.

## 9. How to Think About Similar Systems

When you meet another agent product (Claude Code, Codex CLI, Cursor's agent mode, an in-house one), ask the same questions in the same order.

1. **What is the loop's exit condition, and who owns it?** Usually "no tool calls in the last message". Then look for the bounds around it: max turns, token budgets, abort, hooks.
2. **What is the projection from storage to request?** The difference between the stored transcript and what the model sees is where memory strategy lives: truncation, summarization, retrieval, or sub-agent isolation.
3. **Where is the policy choke point?** Every harness has one place between "model asked" and "world changed". Find it. If it does not exist, the harness is relying on the deployment for safety.
4. **How does failure reach the model?** Systems that turn errors into tool results are self-correcting. Systems that throw are brittle.
5. **How is output bounded?** Any tool that can return unbounded text needs a cap, a tail-or-head choice, and an escape hatch to the full data.
6. **How is cancellation propagated?** Follow the abort signal from the UI down to the process group. Gaps there are where hung processes and orphaned servers come from.
7. **Is the prefix stable?** Cost and latency depend on whether consecutive requests share a byte-identical prefix. Look for how the harness handles prompt changes (patches versus rewrites), tool-set changes, and compaction.
8. **What untrusted text reaches the context, and what can it trigger?** Files, command output, web pages, and MCP tool results are all potential injection vectors. Trace what the model could do if one of them gave it instructions.
9. **How are transient failures retried?** Rate limits and overloaded providers are normal on long runs. Check that retries back off and do not resend a half-finished assistant message.

Sub-agents, plan modes, and "memory" features are mostly variations on the same primitives: a second loop with its own transcript, a loop with a restricted tool set, and a storage layer that feeds the projection. MCP fits the same way: it is a protocol for sourcing tools from external servers, and those tools land in the same executor, behind the same validation and hooks, as built-in ones (Pi ships it as a separate `pi-mcp` package). Once you can see the loop, the projection, and the choke point, most agent products reduce to a small set of choices about each.

> **Takeaway**: an agent harness is a loop around a stateless function, plus the machinery that keeps that loop bounded, observable, cancellable, and resumable. The model decides what to do next, and the harness decides what is allowed to happen.

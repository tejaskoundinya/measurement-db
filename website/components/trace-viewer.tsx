"use client";

/* ============================================================
   TraceViewer — renders one trace/1 value (see lib/traces/display.ts)
   as a transcript: model turns with their tool calls, tool results
   indented under them, harness messages, and the grader's result.
   Trace content is only ever rendered as text, never as HTML.
   ============================================================ */

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  LlmStep,
  MessageStep,
  ToolStep,
  Trace,
  TraceStep,
} from "@/lib/traces/display";

type Kind = "llm" | "tool" | "tool-nz" | "tool-err" | "harness" | "context";
const KIND: Record<Kind, { color: string; label: string }> = {
  llm: { color: "var(--digital-blue)", label: "model turn" },
  tool: { color: "var(--digital-green)", label: "tool ok" },
  "tool-nz": { color: "var(--poppy)", label: "tool non-zero exit" },
  "tool-err": { color: "var(--digital-red)", label: "tool error" },
  harness: { color: "var(--plum)", label: "harness message" },
  context: { color: "var(--stone)", label: "system / task / other" },
};

function kindOf(step: TraceStep): Kind {
  if (step.type === "llm") return "llm";
  if (step.type === "tool")
    return step.error
      ? "tool-err"
      : step.exitCode != null && step.exitCode !== 0
        ? "tool-nz"
        : "tool";
  return step.type === "message" && step.label === "harness"
    ? "harness"
    : "context";
}

function searchText(step: TraceStep) {
  if (step.type === "llm")
    return [
      step.content,
      step.reasoning,
      ...(step.toolCalls ?? []).map((c) => c.arguments),
    ].join("\n");
  if (step.type === "tool") return [step.output, step.error].join("\n");
  return step.content ?? "";
}

const int = (n?: number) => (n == null ? "–" : Math.round(n).toLocaleString());
const money = (c?: number) =>
  c == null ? "–" : "$" + (c < 0.01 ? c.toFixed(4) : c.toFixed(2));
function duration(s?: number) {
  if (s == null) return "–";
  if (s < 1) return `${Math.round(s * 1000)} ms`;
  if (s < 90) return `${s.toFixed(1)} s`;
  if (s < 5400) return `${(s / 60).toFixed(1)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

/* ---------- text with search highlighting ---------- */
function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const lower = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (let hit = lower.indexOf(query); hit !== -1; ) {
    if (hit > at) parts.push(text.slice(at, hit));
    parts.push(
      <mark key={hit} className="rounded-sm bg-[#ffe58a] text-inherit">
        {text.slice(hit, hit + query.length)}
      </mark>,
    );
    at = hit + query.length;
    hit = lower.indexOf(query, at);
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

function Omitted({ from, shown }: { from?: number; shown: number }) {
  if (from == null) return null;
  return (
    <p className="mt-1 text-[0.6875rem] text-[var(--muted)]">
      Showing the first {shown.toLocaleString()} of {from.toLocaleString()}{" "}
      characters.
    </p>
  );
}

/** Monospace block clamped to `lines`, with "Show all N lines". */
function Block({
  text,
  lines,
  query,
  expandAll,
  truncatedFrom,
}: {
  text: string;
  lines: number;
  query: string;
  expandAll: boolean;
  truncatedFrom?: number;
}) {
  const [open, setOpen] = useState(false);
  const count = text.split("\n").length;
  const hit = !!query && text.toLowerCase().includes(query);
  const clamped = count > lines && !open && !expandAll && !hit;
  return (
    <div>
      <pre
        className="m-0 overflow-hidden whitespace-pre-wrap break-words rounded border border-[var(--line)] bg-[var(--fog-light)] px-2.5 py-2 font-mono text-[0.75rem] leading-[1.45]"
        style={
          clamped
            ? {
                maxHeight: `calc(1.45em * ${lines} + 1rem)`,
                maskImage: "linear-gradient(to bottom, #000 75%, transparent)",
                WebkitMaskImage:
                  "linear-gradient(to bottom, #000 75%, transparent)",
              }
            : undefined
        }
      >
        <Highlight text={text} query={query} />
      </pre>
      {count > lines && !expandAll && !hit ? (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="mt-1 rounded border border-[var(--line)] bg-white px-2 py-0.5 text-[0.6875rem] text-[var(--muted)] hover:border-[var(--muted)]"
        >
          {open ? "Show less" : `Show all ${count.toLocaleString()} lines`}
        </button>
      ) : null}
      <Omitted from={truncatedFrom} shown={text.length} />
    </div>
  );
}

function commandOf(args?: string) {
  if (args == null) return null;
  try {
    const parsed = JSON.parse(args);
    if (
      parsed &&
      typeof parsed === "object" &&
      Object.keys(parsed).length === 1 &&
      typeof parsed.command === "string"
    )
      return parsed.command as string;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return args;
  }
}
function firstLine(args?: string) {
  const line = (commandOf(args) ?? "").trim().split("\n")[0];
  return line.length > 90 ? line.slice(0, 90) + "…" : line;
}

function Badge({
  tone,
  children,
  title,
}: {
  tone: "ok" | "warn" | "err" | "muted";
  children: React.ReactNode;
  title?: string;
}) {
  const tones = {
    ok: "bg-[color-mix(in_srgb,var(--digital-green)_12%,white)] text-[var(--digital-green)]",
    warn: "bg-[color-mix(in_srgb,var(--poppy)_14%,white)] text-[#9a5b00]",
    err: "bg-[color-mix(in_srgb,var(--digital-red)_10%,white)] text-[var(--digital-red)]",
    muted: "bg-[var(--fog-light)] text-[var(--muted)]",
  };
  return (
    <span
      title={title}
      className={`inline-block rounded px-1.5 text-[0.6875rem] font-semibold ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <span className="rounded-full bg-[var(--fog-light)] px-2.5 py-0.5 text-[0.6875rem] text-[var(--muted)]">
      {label} <b className="font-semibold text-[var(--ink)]">{value}</b>
    </span>
  );
}

/* ---------- steps ---------- */
const MESSAGE_TITLE: Record<MessageStep["label"], string> = {
  system: "System prompt",
  task: "Task",
  harness: "Harness message",
  user: "User",
};

function StepHead({
  title,
  meta,
  index,
}: {
  title: React.ReactNode;
  meta?: string;
  index: number;
}) {
  return (
    <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2 text-[0.6875rem] text-[var(--muted)]">
      <span className="text-[0.75rem] font-semibold text-[var(--ink)]">
        {title}
      </span>
      <span>
        #{index}
        {meta ? ` · ${meta}` : ""}
      </span>
    </div>
  );
}

function Message({
  step,
  index,
  query,
  expandAll,
}: {
  step: MessageStep;
  index: number;
  query: string;
  expandAll: boolean;
}) {
  const harness = step.label === "harness";
  const title = step.participant
    ? `${MESSAGE_TITLE[step.label]} · ${step.participant}`
    : MESSAGE_TITLE[step.label];
  return (
    <>
      <StepHead
        title={title}
        index={index}
        meta={harness ? "sent by the agent harness, not a person" : undefined}
      />
      <Block
        text={step.content}
        lines={harness ? 12 : 8}
        query={query}
        expandAll={expandAll}
        truncatedFrom={step.truncated?.content}
      />
    </>
  );
}

function Llm({
  step,
  index,
  turn,
  query,
  expandAll,
  showReasoning,
  timed,
}: {
  step: LlmStep;
  index: number;
  turn: number;
  query: string;
  expandAll: boolean;
  showReasoning: boolean;
  timed: boolean;
}) {
  const u = step.usage ?? {};
  const meta = [
    u.prompt != null ? `${int(u.prompt)} in` : null,
    u.completion != null
      ? `${int(u.completion)} out` +
        (u.reasoning ? ` (${int(u.reasoning)} reasoning)` : "")
      : null,
    u.cacheRead ? `${int(u.cacheRead)} cached` : null,
    step.cost != null ? money(step.cost) : null,
    timed && step.start != null && step.end != null
      ? duration(step.end - step.start)
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const reasoningHit =
    !!query && !!step.reasoning?.toLowerCase().includes(query);
  const empty = !step.content && !step.reasoning && !step.toolCalls?.length;
  return (
    <>
      <StepHead title={`Model · turn ${turn}`} index={index} meta={meta} />
      {step.reasoning ? (
        <details
          className="mb-1.5"
          open={showReasoning || reasoningHit || undefined}
        >
          <summary className="cursor-pointer text-[0.6875rem] text-[var(--muted)]">
            Reasoning ({step.reasoning.length.toLocaleString()} characters)
          </summary>
          <div className="mt-1 whitespace-pre-wrap break-words text-[0.8125rem] italic text-[var(--text-secondary)]">
            <Highlight text={step.reasoning} query={query} />
          </div>
        </details>
      ) : null}
      {step.content ? (
        <div className="whitespace-pre-wrap break-words text-[0.8125rem] leading-6 text-[var(--ink)]">
          <Highlight text={step.content} query={query} />
          <Omitted
            from={step.truncated?.content}
            shown={step.content.length}
          />
        </div>
      ) : null}
      {(step.toolCalls ?? []).map((call, i) => (
        <div key={call.id ?? i} className="mt-2">
          <p className="mb-0.5 text-[0.6875rem] text-[var(--muted)]">
            calls{" "}
            <b className="font-semibold text-[var(--lagunita-dark)]">
              {call.name ?? "tool"}
            </b>
          </p>
          <Block
            text={commandOf(call.arguments) ?? ""}
            lines={20}
            query={query}
            expandAll={expandAll}
          />
        </div>
      ))}
      {empty ? (
        <p className="text-[0.8125rem] italic text-[var(--muted)]">
          (empty response: no text and no tool call)
        </p>
      ) : null}
    </>
  );
}

function Tool({
  step,
  index,
  query,
  expandAll,
  timed,
}: {
  step: ToolStep;
  index: number;
  query: string;
  expandAll: boolean;
  timed: boolean;
}) {
  const badge = step.error ? (
    <Badge tone="err">error</Badge>
  ) : step.exitCode == null ? (
    <Badge tone="muted">no exit code</Badge>
  ) : (
    <Badge tone={step.exitCode === 0 ? "ok" : "warn"}>
      exit {step.exitCode}
    </Badge>
  );
  const time =
    timed && step.start != null && step.end != null
      ? duration(step.end - step.start)
      : undefined;
  return (
    <>
      <StepHead
        index={index}
        meta={time}
        title={
          <span className="flex min-w-0 flex-wrap items-baseline gap-1.5">
            <span>↳ {step.name ?? "tool"}</span>
            {badge}
            <span className="font-mono font-normal text-[var(--muted)]">
              {firstLine(step.arguments)}
            </span>
          </span>
        }
      />
      {step.error ? (
        <div className="mb-1.5">
          <Block
            text={step.error}
            lines={10}
            query={query}
            expandAll={expandAll}
            truncatedFrom={step.truncated?.error}
          />
        </div>
      ) : null}
      {step.output ? (
        <Block
          text={step.output}
          lines={16}
          query={query}
          expandAll={expandAll}
          truncatedFrom={step.truncated?.output}
        />
      ) : (
        <p className="text-[0.8125rem] italic text-[var(--muted)]">
          (no output)
        </p>
      )}
    </>
  );
}

/* ---------- result ---------- */
function Result({ trace }: { trace: Trace }) {
  const [filter, setFilter] = useState("");
  const run = trace.run ?? {};
  const ev = trace.evaluation;
  const tests = ev?.tests ?? [];
  const counts = new Map<string, number>();
  for (const t of tests) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  const notPassed = tests.filter((t) => t.status !== "passed");
  const shown = notPassed
    .filter((t) => !filter || t.name.toLowerCase().includes(filter))
    .slice(0, 2000);
  const h3 = "mb-1.5 mt-4 text-[0.75rem] font-semibold text-[var(--ink)]";
  return (
    <section className="mt-4 rounded border border-[var(--line)] bg-white p-4">
      <h2 className="mb-2 text-[0.8125rem] font-semibold text-[var(--ink)]">
        Result
      </h2>
      <div className="flex flex-wrap items-center gap-1.5 text-[0.75rem] text-[var(--muted)]">
        Run status:{" "}
        <Badge tone={run.status === "Submitted" ? "ok" : "err"}>
          {run.status ?? "not recorded"}
        </Badge>
        {[...counts].map(([status, n]) => (
          <Chip key={status} label={status} value={n.toLocaleString()} />
        ))}
      </div>
      {!ev ? (
        <p className="mt-2 text-[0.75rem] text-[var(--muted)]">
          This attempt was not graded.
        </p>
      ) : null}
      {ev?.errorCode ? (
        <>
          <h3 className={h3}>Evaluation error: {ev.errorCode}</h3>
          <Block
            text={ev.errorDetails || "(no details)"}
            lines={12}
            query=""
            expandAll={false}
          />
        </>
      ) : null}
      {ev?.judge ? (
        <>
          <h3 className={h3}>
            Judge{ev.judge.participant ? ` · ${ev.judge.participant}` : ""}
          </h3>
          <Block
            text={ev.judge.content}
            lines={12}
            query=""
            expandAll={false}
          />
        </>
      ) : null}
      {run.exception ? (
        <>
          <h3 className={h3}>Exception</h3>
          <Block
            text={
              run.exception + (run.traceback ? "\n\n" + run.traceback : "")
            }
            lines={12}
            query=""
            expandAll={false}
          />
        </>
      ) : null}
      {run.submission ? (
        <>
          <h3 className={h3}>Submission</h3>
          <Block
            text={run.submission}
            lines={12}
            query=""
            expandAll={false}
          />
        </>
      ) : null}
      {tests.length ? (
        <>
          <h3 className={h3}>
            Tests not passed ({notPassed.length.toLocaleString()} of{" "}
            {(ev?.testsTotal ?? tests.length).toLocaleString()} tests in this
            run&apos;s evaluation)
          </h3>
          {notPassed.length ? (
            <input
              type="search"
              placeholder="Filter tests…"
              aria-label="Filter tests"
              onChange={(e) => setFilter(e.target.value.trim().toLowerCase())}
              className="mb-1.5 w-full max-w-sm rounded border border-[var(--line)] px-2 py-1 text-[0.75rem]"
            />
          ) : null}
          <div className="max-h-80 overflow-auto rounded border border-[var(--line)]">
            {shown.length ? (
              shown.map((t, i) => (
                <div
                  key={i}
                  className="flex gap-2 border-b border-[var(--line)] px-2 py-0.5 font-mono text-[0.6875rem] leading-5 last:border-b-0"
                >
                  <Badge tone={/fail|error/i.test(t.status) ? "err" : "warn"}>
                    {t.status}
                  </Badge>
                  <span className="break-all">{t.name}</span>
                </div>
              ))
            ) : (
              <p className="px-2 py-1 text-[0.75rem] italic text-[var(--muted)]">
                {notPassed.length ? "No match." : "Every test passed."}
              </p>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}

/* ---------- viewer ---------- */
export function TraceViewer({ trace }: { trace: Trace }) {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [hitPos, setHitPos] = useState(-1);
  const [focus, setFocus] = useState<number | null>(null);
  const [showReasoning, setShowReasoning] = useState(false);
  const [expandAll, setExpandAll] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(input.trim().toLowerCase());
      setHitPos(-1);
    }, 250);
    return () => clearTimeout(t);
  }, [input]);

  useEffect(() => {
    if (!fullScreen) return;
    scroller.current?.focus();
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullScreen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [fullScreen]);

  const steps = trace.steps;
  const kinds = useMemo(() => steps.map(kindOf), [steps]);
  const hits = useMemo(
    () =>
      query
        ? steps.flatMap((s, i) =>
            searchText(s).toLowerCase().includes(query) ? [i] : [],
          )
        : [],
    [steps, query],
  );
  const hitSet = useMemo(() => new Set(hits), [hits]);
  const timed = trace.timing === "recorded" || trace.timing === "partial";

  const llm = steps.filter((s): s is LlmStep => s.type === "llm");
  const toolCount = steps.filter((s) => s.type === "tool").length;
  const model = llm.find((s) => s.model)?.model;
  const run = trace.run ?? {};
  const ev = trace.evaluation;

  function jump(i: number) {
    setFocus(i);
    const el = scroller.current?.querySelector<HTMLElement>(`[data-step="${i}"]`);
    el?.scrollIntoView({ block: "start" });
  }
  function nextHit(dir: number) {
    if (!hits.length) return;
    const pos = (hitPos + dir + hits.length) % hits.length;
    setHitPos(pos);
    jump(hits[pos]);
  }
  function nextTurn(dir: number) {
    const turns = steps.flatMap((s, i) => (s.type === "llm" ? [i] : []));
    if (!turns.length) return;
    const current = focus ?? -1;
    const target =
      dir > 0
        ? (turns.find((i) => i > current) ?? turns.at(-1)!)
        : ([...turns].reverse().find((i) => i < current) ?? turns[0]);
    jump(target);
  }
  function onKey(e: React.KeyboardEvent) {
    if ((e.target as HTMLElement).matches("input, textarea")) return;
    if (e.key === "/") {
      e.preventDefault();
      searchBox.current?.focus();
    } else if (e.key === "j") nextTurn(1);
    else if (e.key === "k") nextTurn(-1);
    else if (e.key === "Escape" && fullScreen) setFullScreen(false);
  }

  let turn = 0;
  const used = [...new Set(kinds)];
  const agentOf = (s: TraceStep) => s.agent ?? null;

  const viewer = (
    <div
      className={
        fullScreen
          ? "fixed inset-0 z-[100] flex flex-col bg-[var(--fog-light)] p-4"
          : "flex min-w-0 flex-col"
      }
      role={fullScreen ? "dialog" : undefined}
      aria-modal={fullScreen || undefined}
      aria-label={fullScreen ? "Trace" : undefined}
    >
      <div
        ref={scroller}
        tabIndex={0}
        onKeyDown={onKey}
        className={`overflow-auto rounded bg-white outline-none focus-visible:ring-2 focus-visible:ring-[var(--lagunita)] ${fullScreen ? "flex-1" : "max-h-[48rem]"}`}
      >
        {/* Header */}
        <section className="border-b border-[var(--line)] p-4">
          <div className="flex flex-wrap items-center gap-2 text-[0.75rem]">
            {model ? (
              <span className="font-semibold text-[var(--ink)]">{model}</span>
            ) : null}
            <Badge
              tone={run.status === "Submitted" ? "ok" : "err"}
              title="Exit status recorded by the agent harness"
            >
              {run.status ?? "status not recorded"}
            </Badge>
            {ev?.errorCode ? (
              <Badge tone="err" title="The grader reported an error; see Result">
                evaluation: {ev.errorCode}
              </Badge>
            ) : null}
            {ev?.total && ev.notRun === ev.total ? (
              <Badge tone="warn">no tests ran</Badge>
            ) : null}
            {!ev ? <Badge tone="muted">not graded</Badge> : null}
            <button
              type="button"
              onClick={() => setFullScreen(!fullScreen)}
              className="ml-auto rounded border border-[var(--line)] bg-white px-2 py-0.5 text-[0.6875rem] text-[var(--muted)] hover:border-[var(--muted)]"
            >
              {fullScreen ? "Close full screen" : "Open full screen"}
            </button>
          </div>
          {ev?.total ? (
            <div className="mt-2 flex flex-wrap items-center gap-3 text-[0.75rem] text-[var(--muted)]">
              <div
                className="h-2 w-48 overflow-hidden rounded bg-[var(--fog-light)]"
                role="img"
                aria-label={`${ev.passed ?? 0} of ${ev.total} tests passed`}
              >
                <div
                  className="h-full bg-[var(--digital-green)]"
                  style={{ width: `${((ev.passed ?? 0) / ev.total) * 100}%` }}
                />
              </div>
              <span>
                <b className="text-[var(--ink)]">
                  {(ev.passed ?? 0).toLocaleString()} /{" "}
                  {ev.total.toLocaleString()}
                </b>{" "}
                tests passed in this run&apos;s evaluation
              </span>
            </div>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Chip label="cost" value={money(run.cost)} />
            <Chip label="model turns" value={int(llm.length)} />
            {run.apiCalls != null && run.apiCalls !== llm.length ? (
              <Chip label="API calls" value={int(run.apiCalls)} />
            ) : null}
            <Chip label="tool calls" value={int(toolCount)} />
            <Chip label="prompt tokens" value={int(run.promptTokens)} />
            <Chip label="output tokens" value={int(run.completionTokens)} />
            {timed ? (
              <Chip label="duration" value={duration(run.durationS)} />
            ) : null}
          </div>
        </section>

        {/* Toolbar: search + step strip, sticky inside the pane */}
        <div className="sticky top-0 z-10 border-b border-[var(--line)] bg-white/95 px-4 pb-2 pt-3 backdrop-blur">
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={searchBox}
              type="search"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  const q = input.trim().toLowerCase();
                  if (q !== query) setQuery(q);
                  else nextHit(e.shiftKey ? -1 : 1);
                }
              }}
              placeholder="Search this trace (commands, outputs, messages)…"
              aria-label="Search this trace"
              className="min-w-44 flex-1 rounded border border-[var(--line)] px-2.5 py-1 text-[0.8125rem]"
            />
            <span
              className="min-w-16 text-[0.6875rem] text-[var(--muted)]"
              aria-live="polite"
            >
              {query
                ? hitPos >= 0
                  ? `${hitPos + 1} / ${hits.length} steps`
                  : `${hits.length} step${hits.length === 1 ? "" : "s"}`
                : ""}
            </span>
            {[
              ["↑", -1, "Previous match"],
              ["↓", 1, "Next match"],
            ].map(([label, dir, name]) => (
              <button
                key={name as string}
                type="button"
                aria-label={name as string}
                disabled={!hits.length}
                onClick={() => nextHit(dir as number)}
                className="rounded border border-[var(--line)] bg-white px-2 py-0.5 text-[0.75rem] disabled:opacity-40"
              >
                {label}
              </button>
            ))}
            <label className="flex cursor-pointer items-center gap-1 text-[0.6875rem] text-[var(--muted)]">
              <input
                type="checkbox"
                checked={showReasoning}
                onChange={(e) => setShowReasoning(e.target.checked)}
              />
              reasoning
            </label>
            <label className="flex cursor-pointer items-center gap-1 text-[0.6875rem] text-[var(--muted)]">
              <input
                type="checkbox"
                checked={expandAll}
                onChange={(e) => setExpandAll(e.target.checked)}
              />
              expand all output
            </label>
          </div>
          <div
            className="mt-2 flex h-4 overflow-hidden rounded bg-[var(--fog-light)]"
            role="group"
            aria-label="Steps; select one to jump to it"
          >
            {kinds.map((k, i) => (
              <button
                key={i}
                type="button"
                tabIndex={-1}
                aria-label={`Step ${i}: ${KIND[k].label}`}
                title={`#${i} ${KIND[k].label}`}
                onClick={() => jump(i)}
                className="relative min-w-px flex-1"
                style={{ background: KIND[k].color }}
              >
                {hitSet.has(i) ? (
                  <span className="absolute inset-x-0 -top-px h-2 min-w-[3px] bg-[var(--ink)]" />
                ) : null}
              </button>
            ))}
          </div>
          <div className="mt-1 flex flex-wrap gap-3 text-[0.625rem] text-[var(--muted)]">
            {used.map((k) => (
              <span key={k} className="flex items-center gap-1">
                <span
                  className="inline-block size-2 rounded-sm"
                  style={{ background: KIND[k].color }}
                />
                {KIND[k].label}
              </span>
            ))}
            <span className="ml-auto">
              <kbd>/</kbd> search · <kbd>j</kbd>/<kbd>k</kbd> next/previous
              turn
            </span>
          </div>
        </div>

        {/* Timeline */}
        <div className="flex flex-col gap-2 p-4">
          {steps.map((step, i) => {
            const k = kinds[i];
            const agent = agentOf(step);
            const newAgent = agent && agent !== agentOf(steps[i - 1] ?? step);
            const border =
              step.type === "tool"
                ? k === "tool-err"
                  ? "border-l-[3px] border-l-[var(--digital-red)]"
                  : k === "tool-nz"
                    ? "border-l-[3px] border-l-[var(--poppy)]"
                    : ""
                : `border-l-[3px]`;
            const style =
              step.type === "tool"
                ? undefined
                : { borderLeftColor: KIND[k].color };
            const tint =
              k === "harness"
                ? "bg-[color-mix(in_srgb,var(--plum)_6%,white)]"
                : step.type === "tool"
                  ? "ml-7 bg-[var(--fog-light)]"
                  : "bg-white";
            return (
              <Fragment key={i}>
                {newAgent || (agent && i === 0) ? (
                  <h3 className="mt-2 text-[0.6875rem] uppercase tracking-wide text-[var(--muted)]">
                    {agent}
                  </h3>
                ) : null}
                <div
                  data-step={i}
                  className={`scroll-mt-28 rounded border border-[var(--line)] px-3 py-2.5 ${border} ${tint} ${focus === i ? "outline outline-2 outline-[var(--lagunita)]" : ""}`}
                  style={style}
                >
                  {step.type === "message" ? (
                    <Message
                      step={step}
                      index={i}
                      query={query}
                      expandAll={expandAll}
                    />
                  ) : step.type === "llm" ? (
                    <Llm
                      step={step}
                      index={i}
                      turn={++turn}
                      query={query}
                      expandAll={expandAll}
                      showReasoning={showReasoning}
                      timed={timed}
                    />
                  ) : step.type === "tool" ? (
                    <Tool
                      step={step}
                      index={i}
                      query={query}
                      expandAll={expandAll}
                      timed={timed}
                    />
                  ) : (
                    <>
                      <StepHead title={`Event · ${step.name}`} index={i} />
                      {step.content ? (
                        <Block
                          text={step.content}
                          lines={8}
                          query={query}
                          expandAll={expandAll}
                        />
                      ) : null}
                    </>
                  )}
                </div>
              </Fragment>
            );
          })}
        </div>
        <div className="px-4 pb-4">
          <Result trace={trace} />
        </div>
      </div>
    </div>
  );
  // Full screen renders into <body>: an animated ancestor would otherwise trap `fixed`.
  return fullScreen ? createPortal(viewer, document.body) : viewer;
}

// SPDX-License-Identifier: Apache-2.0
import type { LoadedCollection } from "../config.js";
import type { Item } from "../sources/types.js";
import { log } from "../log.js";
import { selectorRequests } from "../metrics.js";
import type { Answer, ChoiceAnswer, NoulAnswer, Question, TypeSafeClient } from "./typesafe.js";

/** TypeSafe accepts at most 255 options per Choice; one slot is the "none" option. */
export const MAX_CHOICE_CANDIDATES = 254;
/** Upper bound on per-item yes/no questions for one `pick_all` collection, to cap request cost. */
export const MAX_NOUL_CANDIDATES = 255;
const SUMMARY_MAX_CHARS = 300;
const DEFAULT_SUMMARY_TTL_MS = 5 * 60_000;

export interface SelectorCollectionSettings {
  collection: LoadedCollection;
  mode: "pick_one" | "pick_all";
  /** pick_one: below this confidence, report candidates instead of a pick. */
  minConfidence: number;
  /** pick_all: include every item whose yes-probability is at least this. */
  threshold: number;
  /** How many ranked candidates to return. */
  topK: number;
}

export interface GuidanceSelectorOptions {
  client: Pick<TypeSafeClient, "ask">;
  collections: SelectorCollectionSettings[];
  includeContent: boolean;
  summaryTtlMs?: number;
  /** Surfaced by `doctor`; never includes the key itself. */
  info?: { model: string; apiKeyConfigured: boolean };
}

export interface SelectInput {
  task: string;
  context?: { repo?: string; files?: string[]; language?: string };
}

export interface Candidate {
  /** Item name without extension, so `tagging.md` + `tagging.rego` are one candidate. */
  key: string;
  /** Underlying items, markdown first. */
  items: Item[];
  summary?: string;
}

interface RankedEntry {
  name: string;
  items: string[];
  p: number;
}

export interface PickOneResult {
  mode: "pick_one";
  pick: { name: string; items: string[]; summary?: string; content?: string } | null;
  reason: "confident" | "low_confidence" | "none_applies";
  confidence: number;
  ranked: RankedEntry[];
}

export interface PickAllResult {
  mode: "pick_all";
  applies: Array<RankedEntry & { summary?: string; content?: string }>;
  threshold: number;
  considered: number;
}

export interface FailedResult {
  error: string;
  fallback: string;
}

export type CollectionResult = PickOneResult | PickAllResult | FailedResult;

export interface SelectOutput {
  model?: string;
  results: Record<string, CollectionResult>;
  next: string[];
}

interface Plan {
  settings: SelectorCollectionSettings;
  candidates: Candidate[];
  noneKey?: string;
  questionKeys: string[];
}

export class GuidanceSelector {
  private readonly summaryCache = new Map<string, { at: number; summary: string | undefined }>();
  private readonly summaryTtlMs: number;

  constructor(private readonly opts: GuidanceSelectorOptions) {
    this.summaryTtlMs = opts.summaryTtlMs ?? DEFAULT_SUMMARY_TTL_MS;
  }

  get info(): { model: string; apiKeyConfigured: boolean } | undefined {
    return this.opts.info;
  }

  get collectionNames(): string[] {
    return this.opts.collections.map((c) => c.collection.name);
  }

  async select(input: SelectInput, isAllowed: (collection: string) => boolean = () => true): Promise<SelectOutput> {
    const active = this.opts.collections.filter((c) => isAllowed(c.collection.name));
    if (active.length === 0) throw new Error("no selector collections are accessible to this principal");

    const results: Record<string, CollectionResult> = {};
    const plans: Plan[] = [];
    const questions: Record<string, Question> = {};

    const catalogs = await Promise.all(active.map(async (s) => ({ s, ...(await this.buildCandidates(s.collection)) })));
    for (const { s, candidates, errors } of catalogs) {
      const name = s.collection.name;
      if (candidates.length === 0) {
        results[name] = failed(name, errors.length > 0 ? `no items (source errors: ${errors.join("; ")})` : "collection has no items");
        continue;
      }
      if (s.mode === "pick_one") {
        if (candidates.length > MAX_CHOICE_CANDIDATES) {
          results[name] = failed(name, `${candidates.length} candidates exceeds the ${MAX_CHOICE_CANDIDATES}-option limit for pick_one`);
          continue;
        }
        const noneKey = uniqueNoneKey(candidates);
        const criteria: Record<string, string | null> = {};
        for (const c of candidates) criteria[c.key] = c.summary ?? null;
        criteria[noneKey] = "None of the other options is relevant to this task.";
        const qKey = name;
        questions[qKey] = {
          type: "choice",
          instructions: {
            collection: { name, description: s.collection.description ?? null },
            question: "Which single item from `collection` should a coding agent follow for the task described in the state?",
          },
          criteria,
        };
        plans.push({ settings: s, candidates, noneKey, questionKeys: [qKey] });
      } else {
        if (candidates.length > MAX_NOUL_CANDIDATES) {
          results[name] = failed(name, `${candidates.length} candidates exceeds the ${MAX_NOUL_CANDIDATES}-item limit for pick_all`);
          continue;
        }
        const keys = candidates.map((c, i) => {
          const qKey = `${name}#${i}`;
          questions[qKey] = {
            type: "noul",
            instructions: {
              item: { name: c.key, summary: c.summary ?? null, collection: name },
              question: "Does `item` apply to the coding task described in the state, such that the agent must follow it?",
            },
            criteria: { true: "The item is relevant and must be followed for this task", false: "The item is unrelated to this task" },
          };
          return qKey;
        });
        plans.push({ settings: s, candidates, questionKeys: keys });
      }
    }

    let model: string | undefined;
    if (plans.length > 0) {
      const state = input.context ? { task: input.task, context: input.context } : { task: input.task };
      try {
        const res = await this.opts.client.ask(state, questions);
        model = res.model;
        for (const plan of plans) {
          results[plan.settings.collection.name] = await this.interpret(plan, res.answers);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("warn", "selector.failed", { error: msg });
        for (const plan of plans) results[plan.settings.collection.name] = failed(plan.settings.collection.name, msg);
      }
    }

    const outcomes = Object.values(results);
    const failures = outcomes.filter(isFailed).length;
    selectorRequests.inc({ outcome: failures === 0 ? "ok" : failures === outcomes.length ? "error" : "partial" });

    return { ...(model ? { model } : {}), results, next: nextSteps(results) };
  }

  private async interpret(plan: Plan, answers: Record<string, Answer>): Promise<CollectionResult> {
    const { settings, candidates } = plan;
    const name = settings.collection.name;
    const byKey = new Map(candidates.map((c) => [c.key, c]));

    if (settings.mode === "pick_one") {
      const ans = answers[plan.questionKeys[0]];
      if (!ans || ans.type !== "choice") return failed(name, "typesafe: missing choice answer");
      const choice = ans as ChoiceAnswer;
      const ranked = Object.entries(choice.probabilities)
        .sort((a, b) => b[1] - a[1])
        .slice(0, settings.topK)
        .map(([key, p]) => ({ name: key, items: byKey.get(key)?.items.map((i) => i.name) ?? [], p: round(p) }));
      const confidence = round(choice.confidence);
      if (choice.choice === plan.noneKey) return { mode: "pick_one", pick: null, reason: "none_applies", confidence, ranked };
      const winner = byKey.get(choice.choice);
      if (!winner) return failed(name, `typesafe: unknown choice '${choice.choice}'`);
      if (choice.confidence < settings.minConfidence) return { mode: "pick_one", pick: null, reason: "low_confidence", confidence, ranked };
      const pick: PickOneResult["pick"] = { name: winner.key, items: winner.items.map((i) => i.name) };
      if (winner.summary) pick.summary = winner.summary;
      if (this.opts.includeContent) {
        const content = await this.fetchContent(settings.collection, winner.items[0]);
        if (content !== undefined) pick.content = content;
      }
      return { mode: "pick_one", pick, reason: "confident", confidence, ranked };
    }

    const scored = candidates.map((c, i) => {
      const ans = answers[plan.questionKeys[i]];
      return { c, p: ans && ans.type === "noul" ? (ans as NoulAnswer).noul : undefined };
    });
    if (scored.every((s) => s.p === undefined)) return failed(name, "typesafe: missing noul answers");
    const applies: PickAllResult["applies"] = [];
    for (const { c, p } of scored.filter((s) => s.p !== undefined && s.p >= settings.threshold).sort((a, b) => b.p! - a.p!)) {
      const entry: PickAllResult["applies"][number] = { name: c.key, items: c.items.map((i) => i.name), p: round(p!) };
      if (c.summary) entry.summary = c.summary;
      if (this.opts.includeContent) {
        const content = await this.fetchContent(settings.collection, c.items[0]);
        if (content !== undefined) entry.content = content;
      }
      applies.push(entry);
    }
    return { mode: "pick_all", applies, threshold: settings.threshold, considered: candidates.length };
  }

  /** List a collection and group its items into candidates with short summaries. */
  async buildCandidates(collection: LoadedCollection): Promise<{ candidates: Candidate[]; errors: string[] }> {
    const errors: string[] = [];
    const lists = await Promise.all(
      collection.sources.map(async (s) => {
        try {
          return await s.list();
        } catch (err) {
          errors.push(`${s.id}: ${err instanceof Error ? err.message : String(err)}`);
          return [] as Item[];
        }
      }),
    );
    const seen = new Set<string>();
    const byKey = new Map<string, Candidate>();
    for (const item of lists.flat()) {
      if (seen.has(item.name)) continue;
      seen.add(item.name);
      const key = stripExtension(item.name);
      const slot = byKey.get(key);
      if (slot) slot.items.push(item);
      else byKey.set(key, { key, items: [item] });
    }
    const candidates = [...byKey.values()];
    for (const c of candidates) c.items.sort((a, b) => Number(isMarkdown(b)) - Number(isMarkdown(a)));
    await Promise.all(
      candidates.map(async (c) => {
        c.summary = await this.summarize(collection, c.items[0]);
      }),
    );
    return { candidates, errors };
  }

  private async summarize(collection: LoadedCollection, item: Item): Promise<string | undefined> {
    if (item.description) return truncate(item.description.trim());
    const cacheKey = `${collection.name}::${item.source}::${item.name}`;
    const hit = this.summaryCache.get(cacheKey);
    if (hit && Date.now() - hit.at < this.summaryTtlMs) return hit.summary;
    const content = await this.fetchContent(collection, item);
    const summary = content === undefined ? item.title : (extractSummary(content, item.content_type) ?? item.title);
    this.summaryCache.set(cacheKey, { at: Date.now(), summary });
    return summary;
  }

  private async fetchContent(collection: LoadedCollection, item: Item): Promise<string | undefined> {
    const source = collection.sources.find((s) => s.id === item.source);
    if (!source) return undefined;
    try {
      return (await source.get(item.name)).content;
    } catch {
      return undefined;
    }
  }
}

/**
 * First heading plus first paragraph for markdown; leading comment block
 * for code-like files (rego, yaml, hcl); otherwise the first few hundred
 * characters.
 */
export function extractSummary(content: string, contentType?: string): string | undefined {
  const lines = content.split("\n");
  if (isMarkdownType(contentType)) {
    let heading: string | undefined;
    const para: string[] = [];
    let inFence = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (line.startsWith("```")) {
        inFence = !inFence;
        if (para.length > 0) break;
        continue;
      }
      if (inFence) continue;
      const h = /^#{1,6}\s+(.*)$/.exec(line);
      if (h) {
        if (para.length > 0) break;
        heading ??= h[1].trim();
        continue;
      }
      if (line === "") {
        if (para.length > 0) break;
        continue;
      }
      para.push(line);
    }
    const text = [heading, para.join(" ")].filter(Boolean).join(": ");
    return text ? truncate(text) : undefined;
  }
  const comments: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    const m = /^(#|\/\/)\s?(.*)$/.exec(line);
    if (m) {
      if (m[2]) comments.push(m[2]);
      continue;
    }
    if (line === "" && comments.length === 0) continue;
    break;
  }
  if (comments.length > 0) return truncate(comments.join(" "));
  const flat = content.replace(/\s+/g, " ").trim();
  return flat ? truncate(flat) : undefined;
}

function failed(collection: string, error: string): FailedResult {
  return { error, fallback: `call ${collection}(action=list) and choose relevant items manually` };
}

function isFailed(r: CollectionResult): r is FailedResult {
  return "error" in r;
}

function nextSteps(results: Record<string, CollectionResult>): string[] {
  const steps: string[] = [];
  for (const [collection, r] of Object.entries(results)) {
    if (isFailed(r)) {
      steps.push(r.fallback);
    } else if (r.mode === "pick_one") {
      if (r.pick) steps.push(`${collection}(action=get, name=${r.pick.items[0]})`);
      else if (r.reason === "low_confidence") steps.push(`review ${collection} ranked candidates and get the relevant one, or call ${collection}(action=list)`);
    } else {
      for (const a of r.applies) steps.push(`${collection}(action=get, name=${a.items[0]})`);
    }
  }
  return steps;
}

function uniqueNoneKey(candidates: Candidate[]): string {
  const taken = new Set(candidates.map((c) => c.key));
  let key = "none_of_these";
  while (taken.has(key)) key = `_${key}`;
  return key;
}

function stripExtension(name: string): string {
  return name.replace(/\.[^./]+$/, "");
}

function isMarkdown(item: Item): boolean {
  return isMarkdownType(item.content_type) || /\.(md|markdown)$/i.test(item.name);
}

function isMarkdownType(contentType?: string): boolean {
  return !!contentType && contentType.toLowerCase().includes("markdown");
}

function truncate(s: string): string {
  return s.length > SUMMARY_MAX_CHARS ? `${s.slice(0, SUMMARY_MAX_CHARS - 1)}…` : s;
}

function round(p: number): number {
  return Math.round(p * 1000) / 1000;
}

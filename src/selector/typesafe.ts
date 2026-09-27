// SPDX-License-Identifier: Apache-2.0
import { abortableFetch } from "../util/timeout.js";

/**
 * Minimal client for TypeSafe's System One endpoint
 * (https://docs.typesafe.ai/api). Only the two question types the
 * selector uses are modelled: `choice` (pick one of N, with a full
 * probability distribution) and `noul` (probability a yes/no is yes).
 */

export interface ChoiceQuestion {
  type: "choice";
  instructions: unknown;
  criteria: Record<string, string | null>;
}

export interface NoulQuestion {
  type: "noul";
  instructions: unknown;
  criteria?: { true?: string; false?: string };
}

export type Question = ChoiceQuestion | NoulQuestion;

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export type Answer = ChoiceAnswer | NoulAnswer;

export interface TypeSafeClientOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Overall deadline across all attempts, in milliseconds. */
  timeoutMs: number;
  /** Retries on 429 / 529 only. */
  maxRetries?: number;
  /** Base backoff between retries; doubles each attempt. */
  backoffMs?: number;
}

const RETRYABLE = new Set([429, 529]);

export class TypeSafeClient {
  private readonly url: string;

  constructor(private readonly opts: TypeSafeClientOptions) {
    this.url = `${opts.baseUrl.replace(/\/+$/, "")}/v1/systemone`;
  }

  async ask(state: unknown, questions: Record<string, Question>): Promise<{ model: string; answers: Record<string, Answer> }> {
    if (!this.opts.apiKey) throw new Error("typesafe: api_key is empty (is TYPESAFE_API_KEY set?)");
    const body = JSON.stringify({ state, model: this.opts.model, questions });
    const deadline = Date.now() + this.opts.timeoutMs;
    const maxRetries = this.opts.maxRetries ?? 2;
    let backoff = this.opts.backoffMs ?? 250;

    for (let attempt = 0; ; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`typesafe: timed out after ${this.opts.timeoutMs}ms`);
      const res = await abortableFetch(
        this.url,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json" },
          body,
        },
        remaining,
        "typesafe",
      );
      if (res.ok) {
        const json = (await res.json()) as { model?: string; answers?: Record<string, Answer> };
        if (!json.answers || typeof json.answers !== "object") throw new Error("typesafe: response missing 'answers'");
        return { model: json.model ?? this.opts.model, answers: json.answers };
      }
      if (RETRYABLE.has(res.status) && attempt < maxRetries && Date.now() + backoff < deadline) {
        await new Promise((r) => setTimeout(r, backoff));
        backoff *= 2;
        continue;
      }
      const text = await res.text().catch(() => "");
      throw new Error(`typesafe: HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    }
  }
}

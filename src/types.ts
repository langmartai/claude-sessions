/**
 * Shared types for claude-sessions package.
 * Extracted from lm-assist core types.
 */

// ============================================================================
// Token & Cost Types
// ============================================================================

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  cacheCreation?: {
    ephemeral5mInputTokens: number;
    ephemeral1hInputTokens: number;
  };
}

export interface ModelPricing {
  /** Model identifier pattern */
  modelPattern: string;
  /** Display name */
  displayName: string;
  /** Input token price per 1M */
  inputPricePerMillion: number;
  /** Output token price per 1M */
  outputPricePerMillion: number;
  /** 5-minute cache write price per 1M */
  cache5mWritePricePerMillion: number;
  /** 1-hour cache write price per 1M */
  cache1hWritePricePerMillion: number;
  /** Cache read price per 1M */
  cacheReadPricePerMillion: number;
  /** Input price per 1M for tokens above tiered threshold */
  inputPricePerMillionAbove200k?: number;
  /** Output price per 1M for tokens above tiered threshold */
  outputPricePerMillionAbove200k?: number;
  /** 5-minute cache write price per 1M above tiered threshold */
  cache5mWritePricePerMillionAbove200k?: number;
  /** 1-hour cache write price per 1M above tiered threshold */
  cache1hWritePricePerMillionAbove200k?: number;
  /** Cache read price per 1M above tiered threshold */
  cacheReadPricePerMillionAbove200k?: number;
  /** Token threshold for tiered pricing (default: 200000) */
  tieredThreshold?: number;
}

export interface CostEstimate {
  /** Input cost */
  inputCost: number;
  /** Output cost */
  outputCost: number;
  /** Cache write cost */
  cacheWriteCost: number;
  /** Cache read cost */
  cacheReadCost: number;
  /** Total cost */
  totalCost: number;
  /** Token breakdown */
  tokens: TokenUsage;
  /** Model used */
  model: string;
}

export interface UsageSummary {
  /** Period start */
  periodStart: Date;
  /** Period end */
  periodEnd: Date;
  /** Total messages */
  totalMessages: number;
  /** Total tokens */
  totalTokens: number;
  /** Total cost */
  totalCost: number;
  /** Cost by model */
  costByModel: Record<string, number>;
  /** Cost by day */
  costByDay: Record<string, number>;
  /** Top sessions by cost */
  topSessions: Array<{ sessionId: string; cost: number }>;
}

// ============================================================================
// Content Block Types
// ============================================================================

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'thinking';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

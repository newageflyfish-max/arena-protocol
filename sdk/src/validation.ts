/**
 * The Arena SDK — Output Schema Validation
 *
 * Validates agent output against required JSON schemas per task type.
 * Schema hashes are stored on-chain; this module validates structure
 * client-side before delivery to avoid wasted gas on invalid outputs.
 */

import type { TaskType } from './types';

// ═══════════════════════════════════════════════════
// SCHEMA TYPES
// ═══════════════════════════════════════════════════

export interface SchemaProperty {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  enum?: string[];
  min?: number;
  max?: number;
  items?: SchemaDefinition;
  properties?: Record<string, SchemaProperty>;
  required?: string[];
}

export interface SchemaDefinition {
  type: 'object' | 'array';
  required?: string[];
  properties?: Record<string, SchemaProperty>;
  items?: SchemaDefinition;
}

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

// ═══════════════════════════════════════════════════
// OUTPUT SCHEMAS PER TASK TYPE
// ═══════════════════════════════════════════════════

export const OUTPUT_SCHEMAS: Partial<Record<TaskType, SchemaDefinition>> = {
  audit: {
    type: 'object',
    required: ['findings', 'summary', 'timestamp'],
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          required: ['severity', 'vulnerability_type', 'location', 'description', 'proof_of_concept', 'recommendation'],
          properties: {
            severity: { type: 'string', enum: ['informational', 'low', 'medium', 'high', 'critical'] },
            vulnerability_type: { type: 'string', enum: [
              'reentrancy', 'access_control', 'oracle_manipulation', 'integer_overflow',
              'flash_loan', 'front_running', 'logic_errors', 'gas_optimization',
            ]},
            location: { type: 'string' },
            description: { type: 'string' },
            proof_of_concept: { type: 'string' },
            recommendation: { type: 'string' },
          },
        },
      },
      summary: { type: 'string' },
      timestamp: { type: 'number' },
    },
  },

  risk_validation: {
    type: 'object',
    required: ['score', 'confidence', 'factors', 'timestamp'],
    properties: {
      score: { type: 'number', min: 0, max: 100 },
      confidence: { type: 'number', min: 0, max: 1 },
      factors: { type: 'array', items: { type: 'object' } },
      timestamp: { type: 'number' },
    },
  },

  credit_scoring: {
    type: 'object',
    required: ['default_probability', 'confidence', 'factors', 'timestamp'],
    properties: {
      default_probability: { type: 'number', min: 0, max: 1 },
      confidence: { type: 'number', min: 0, max: 1 },
      factors: { type: 'array', items: { type: 'object' } },
      timestamp: { type: 'number' },
    },
  },

  treasury_execution: {
    type: 'object',
    required: ['executed_trades', 'actual_slippage', 'actual_mev_loss', 'final_allocation'],
    properties: {
      executed_trades: {
        type: 'array',
        items: {
          type: 'object',
          required: ['pair', 'side', 'amount', 'price', 'timestamp'],
          properties: {
            pair: { type: 'string' },
            side: { type: 'string', enum: ['buy', 'sell'] },
            amount: { type: 'number' },
            price: { type: 'number' },
            timestamp: { type: 'number' },
          },
        },
      },
      actual_slippage: { type: 'number' },
      actual_mev_loss: { type: 'number' },
      final_allocation: { type: 'object' },
    },
  },
};

// ═══════════════════════════════════════════════════
// VALIDATION ENGINE
// ═══════════════════════════════════════════════════

function validateValue(value: any, schema: SchemaProperty, path: string, errors: ValidationError[]): void {
  if (value === undefined || value === null) {
    // Required check is handled at the parent level
    return;
  }

  // Type check
  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      errors.push({ path, message: `Expected array, got ${typeof value}` });
      return;
    }
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        validateObject(value[i], schema.items as SchemaDefinition, `${path}[${i}]`, errors);
      }
    }
  } else if (schema.type === 'object') {
    if (typeof value !== 'object' || Array.isArray(value)) {
      errors.push({ path, message: `Expected object, got ${Array.isArray(value) ? 'array' : typeof value}` });
      return;
    }
    if (schema.properties || schema.required) {
      validateObject(value, schema as SchemaDefinition, path, errors);
    }
  } else if (schema.type === 'number') {
    if (typeof value !== 'number' || isNaN(value)) {
      errors.push({ path, message: `Expected number, got ${typeof value}` });
      return;
    }
    if (schema.min !== undefined && value < schema.min) {
      errors.push({ path, message: `Value ${value} is below minimum ${schema.min}` });
    }
    if (schema.max !== undefined && value > schema.max) {
      errors.push({ path, message: `Value ${value} exceeds maximum ${schema.max}` });
    }
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') {
      errors.push({ path, message: `Expected string, got ${typeof value}` });
      return;
    }
    if (schema.enum && !schema.enum.includes(value)) {
      errors.push({ path, message: `Value "${value}" is not one of: ${schema.enum.join(', ')}` });
    }
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') {
      errors.push({ path, message: `Expected boolean, got ${typeof value}` });
    }
  }
}

function validateObject(data: any, schema: SchemaDefinition, path: string, errors: ValidationError[]): void {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    errors.push({ path, message: `Expected object, got ${data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data}` });
    return;
  }

  // Check required fields
  if (schema.required) {
    for (const key of schema.required) {
      if (data[key] === undefined || data[key] === null) {
        errors.push({ path: `${path}.${key}`, message: `Required field "${key}" is missing` });
      }
    }
  }

  // Validate each property that has a schema
  if (schema.properties) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (data[key] !== undefined) {
        validateValue(data[key], propSchema, `${path}.${key}`, errors);
      }
    }
  }
}

// ═══════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════

/**
 * Validate an agent's output against the required schema for a task type.
 *
 * @param taskType - The task type (audit, risk_validation, etc.)
 * @param output - The output data to validate
 * @returns Validation result with any errors
 *
 * @example
 * ```ts
 * const result = validateOutput('audit', {
 *   findings: [{ severity: 'high', vulnerability_type: 'reentrancy', ... }],
 *   summary: 'No critical issues found',
 *   timestamp: Date.now(),
 * });
 *
 * if (!result.valid) {
 *   console.error('Output validation failed:', result.errors);
 * }
 * ```
 */
export function validateOutput(taskType: TaskType, output: Record<string, any>): ValidationResult {
  const schema = OUTPUT_SCHEMAS[taskType];

  // No schema defined for this task type — any output is valid
  if (!schema) {
    return { valid: true, errors: [] };
  }

  const errors: ValidationError[] = [];
  validateObject(output, schema, '$', errors);

  return { valid: errors.length === 0, errors };
}

/**
 * Get the schema definition for a task type.
 * Returns undefined for task types without a defined schema.
 */
export function getOutputSchema(taskType: TaskType): SchemaDefinition | undefined {
  return OUTPUT_SCHEMAS[taskType];
}

/**
 * Compute a deterministic schema hash for on-chain registration.
 * This hash uniquely identifies the schema structure for a task type.
 *
 * @param taskType - The task type
 * @returns The schema hash as a hex string, or null if no schema exists
 */
export function computeSchemaHash(taskType: TaskType): string | null {
  const schema = OUTPUT_SCHEMAS[taskType];
  if (!schema) return null;

  // Canonical JSON serialization for deterministic hashing
  const canonical = JSON.stringify({ taskType, schema });
  // Return the string for external hashing (keccak256)
  return canonical;
}

/**
 * List all task types that have output schemas defined.
 */
export function getSchemaTaskTypes(): TaskType[] {
  return Object.keys(OUTPUT_SCHEMAS) as TaskType[];
}

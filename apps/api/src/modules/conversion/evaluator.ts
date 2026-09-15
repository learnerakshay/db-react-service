import { QualificationResult } from '../../generated/prisma/enums.js';
import type {
  QualificationConfig,
  QualificationField,
  QualificationRequirement,
} from './config.js';

export type FactValue = string | number | boolean;

// A type alias (not an interface) so it is assignable to Prisma JSON input.
export type FailedRequirement = {
  field: string;
  requirement: QualificationRequirement;
};

export interface QualificationDecision {
  result: QualificationResult;
  /** Configured fields without a usable value, in config order. */
  missingFields: string[];
  failedRequirements: FailedRequirement[];
  /** First missing field when PENDING_INFORMATION; otherwise null. */
  nextField: string | null;
}

/**
 * The single qualification decision. Pure and deterministic: operator rules
 * plus known facts in, result out. No model output reaches this function
 * except as facts that already passed validation.
 *
 *  - any known value failing a requirement → NOT_QUALIFIED
 *  - otherwise any field without a usable value → PENDING_INFORMATION
 *  - otherwise → QUALIFIED
 */
export function evaluateQualification(
  config: QualificationConfig,
  facts: ReadonlyMap<string, unknown>,
): QualificationDecision {
  const missingFields: string[] = [];
  const failedRequirements: FailedRequirement[] = [];

  for (const field of config.fields) {
    const value = parseFactValue(field, facts.get(field.key));
    if (value === undefined) {
      missingFields.push(field.key);
      continue;
    }
    for (const requirement of field.requirements) {
      if (!meetsRequirement(value, requirement)) {
        failedRequirements.push({ field: field.key, requirement });
      }
    }
  }

  if (failedRequirements.length > 0) {
    return {
      result: QualificationResult.NOT_QUALIFIED,
      missingFields,
      failedRequirements,
      nextField: null,
    };
  }
  if (missingFields.length > 0) {
    return {
      result: QualificationResult.PENDING_INFORMATION,
      missingFields,
      failedRequirements,
      nextField: missingFields[0] ?? null,
    };
  }
  return {
    result: QualificationResult.QUALIFIED,
    missingFields,
    failedRequirements,
    nextField: null,
  };
}

/** A value usable for `field`, or undefined when absent or of the wrong type. */
export function parseFactValue(field: QualificationField, value: unknown): FactValue | undefined {
  switch (field.type) {
    case 'string':
      return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined;
  }
}

function meetsRequirement(value: FactValue, requirement: QualificationRequirement): boolean {
  switch (requirement.kind) {
    case 'present':
      return true;
    case 'equals':
      return typeof value === 'string' && typeof requirement.value === 'string'
        ? fold(value) === fold(requirement.value)
        : value === requirement.value;
    case 'oneOf':
      return typeof value === 'string' && requirement.values.some((v) => fold(v) === fold(value));
    case 'min':
      return typeof value === 'number' && value >= requirement.value;
    case 'max':
      return typeof value === 'number' && value <= requirement.value;
  }
}

function fold(value: string): string {
  return value.trim().toLowerCase();
}

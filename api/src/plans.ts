export interface Recommendation {
  id: string; kind: 'delete_orphan'; resource_id: string; service: string; region: string;
  monthly_savings_usd: number; days_observed: number;
  evidence: { record_count: number; first_date: string; last_date: string; sample_record_ids: string[] };
  rationale: string;
}

/** Builds a Terraform-style change plan. Pure function: it has no way to reach any cloud API. */
export function buildDeletePlan(rec: Recommendation) {
  const tfName = rec.resource_id.replace(/[^a-zA-Z0-9_]/g, '_');
  const plan = {
    recommendationId: rec.id,
    action: 'delete_resource',
    resource: rec.resource_id,
    terraformDiff: [
      `  # aws_ebs_volume.${tfName} will be destroyed`,
      `  - resource "aws_ebs_volume" "${tfName}" {`,
      `      - id     = "${rec.resource_id}" -> null`,
      `      - region = "${rec.region}" -> null`,
      '    }',
      'Plan: 0 to add, 0 to change, 1 to destroy.',
    ].join('\n'),
    estimatedMonthlySavingsUsd: rec.monthly_savings_usd,
    savingsKind: 'gross (before any snapshot/backup cost or one-off fees)',
    risks: [
      'Data on the resource is lost unless a snapshot exists.',
      'Resource may be referenced by something outside the billing data (DR runbooks, scripts).',
      'The orphan heuristic is based on missing tags and project, not on proven non-use.',
    ],
    assumptions: [
      `monthly savings = average daily cost over ${rec.days_observed} observed days x 30`,
      'cost stays flat; no pricing change',
    ],
  };
  return plan;
}

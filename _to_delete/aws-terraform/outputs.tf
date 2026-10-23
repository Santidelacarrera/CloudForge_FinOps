output "analysis_role_arn" { value = aws_iam_role.analysis.arn }
output "remediation_role_arn" { value = try(aws_iam_role.remediation[0].arn, null) }
output "data_bucket" { value = aws_s3_bucket.data.bucket }

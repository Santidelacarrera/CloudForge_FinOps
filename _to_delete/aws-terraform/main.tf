data "aws_iam_policy_document" "trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "AWS"
      identifiers = var.trusted_principal_arns
    }
    condition {
      test     = "StringEquals"
      variable = "sts:ExternalId"
      values   = [var.external_id]
    }
  }
}

# ---- 1. Analysis role: READ-ONLY. Used by ingestion/analytics connectors. No write actions at all. ----
resource "aws_iam_role" "analysis" {
  name                 = "${var.name_prefix}-analysis-readonly"
  assume_role_policy   = data.aws_iam_policy_document.trust.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "analysis" {
  statement {
    sid       = "CostAndUsageReadOnly"
    actions   = ["ce:Get*", "ce:List*", "ce:Describe*", "cur:DescribeReportDefinitions"]
    resources = ["*"]
  }
  statement {
    sid       = "InventoryReadOnly"
    actions   = ["ec2:Describe*", "rds:Describe*", "tag:GetResources"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "analysis" {
  role   = aws_iam_role.analysis.id
  policy = data.aws_iam_policy_document.analysis.json
}

# ---- 2. Remediation role: narrow, off by default, assumed only by the apply_plan node after approval. ----
resource "aws_iam_role" "remediation" {
  count                = var.remediation_enabled ? 1 : 0
  name                 = "${var.name_prefix}-remediation-scoped"
  assume_role_policy   = data.aws_iam_policy_document.trust.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "remediation" {
  # Only volumes that are NOT attached and are explicitly marked as safe to delete by the plan's tag.
  statement {
    sid       = "DeleteApprovedOrphanVolumes"
    actions   = ["ec2:DeleteVolume"]
    resources = ["arn:aws:ec2:${var.region}:*:volume/*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/cloudforge:approved-for-deletion"
      values   = ["true"]
    }
  }
  statement {
    sid       = "TagApprovedVolumes"
    actions   = ["ec2:CreateTags"]
    resources = ["arn:aws:ec2:${var.region}:*:volume/*"]
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = ["cloudforge:approved-for-deletion"]
    }
  }
}

resource "aws_iam_role_policy" "remediation" {
  count  = var.remediation_enabled ? 1 : 0
  role   = aws_iam_role.remediation[0].id
  policy = data.aws_iam_policy_document.remediation.json
}

# ---- 3. Bucket for source CSVs and execution logs. ----
resource "aws_s3_bucket" "data" {
  bucket_prefix = "${var.name_prefix}-data-"
}

resource "aws_s3_bucket_public_access_block" "data" {
  bucket                  = aws_s3_bucket.data.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "data" {
  bucket = aws_s3_bucket.data.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "data" {
  bucket = aws_s3_bucket.data.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "aws:kms" }
  }
}

# ---- 4. Demo waste the platform should find: an unattached, untagged volume. ----
resource "aws_ebs_volume" "orphan_demo" {
  count             = var.remediation_enabled ? 1 : 0
  availability_zone = "${var.region}a"
  size              = 20
  tags              = { Name = "orphan-demo" }
}

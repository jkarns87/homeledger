data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id          = data.aws_caller_identity.current.account_id
  region              = data.aws_region.current.region
  manuals_bucket      = "${var.name_prefix}-manuals-${local.account_id}"
  vector_bucket       = "${var.name_prefix}-vectors"
  manuals_prefix      = "manuals/${var.household_id}/"
  embedding_model_arn = var.embedding_model_arn != "" ? var.embedding_model_arn : "arn:aws:bedrock:${local.region}::foundation-model/amazon.titan-embed-text-v2:0"
}

# ---------- Manuals bucket ----------
# Layout, from design section 5: manuals/<householdId>/<docId>.pdf plus a
# sidecar <docId>.pdf.metadata.json carrying applianceId and title. The
# sidecar is what makes the applianceId metadata filter possible at retrieval
# time; Bedrock reads it and never embeds it as a chunk.
resource "aws_s3_bucket" "manuals" {
  bucket        = local.manuals_bucket
  force_destroy = var.force_destroy
}

resource "aws_s3_bucket_public_access_block" "manuals" {
  bucket                  = aws_s3_bucket.manuals.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "manuals" {
  bucket = aws_s3_bucket.manuals.id
  versioning_configuration {
    status = "Enabled"
  }
}

# trivy:ignore:AVD-AWS-0132 SSE-S3 (AES256) is deliberate for the demo: a customer-managed KMS key adds cost, rotation, and key-policy overhead the brief did not call for; Bedrock's knowledge base role only needs bucket-default encryption to read these objects.
resource "aws_s3_bucket_server_side_encryption_configuration" "manuals" {
  bucket = aws_s3_bucket.manuals.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# ---------- S3 Vectors ----------
resource "aws_s3vectors_vector_bucket" "manuals" {
  vector_bucket_name = local.vector_bucket
}

resource "aws_s3vectors_index" "manuals" {
  index_name         = "manuals"
  vector_bucket_name = aws_s3vectors_vector_bucket.manuals.vector_bucket_name
  data_type          = "float32"
  dimension          = var.vector_dimension
  distance_metric    = "cosine"
}

# ---------- Knowledge base service role ----------
data "aws_iam_policy_document" "kb_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["bedrock.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:bedrock:${local.region}:${local.account_id}:knowledge-base/*"]
    }
  }
}

data "aws_iam_policy_document" "kb" {
  statement {
    sid       = "InvokeEmbeddingModel"
    actions   = ["bedrock:InvokeModel"]
    resources = [local.embedding_model_arn]
  }
  statement {
    sid       = "ReadManuals"
    actions   = ["s3:GetObject", "s3:ListBucket"]
    resources = [aws_s3_bucket.manuals.arn, "${aws_s3_bucket.manuals.arn}/*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceAccount"
      values   = [local.account_id]
    }
  }
  statement {
    sid = "WriteVectors"
    actions = [
      "s3vectors:GetIndex",
      "s3vectors:ListIndexes",
      "s3vectors:PutVectors",
      "s3vectors:GetVectors",
      "s3vectors:QueryVectors",
      "s3vectors:DeleteVectors",
      "s3vectors:ListVectors"
    ]
    resources = [aws_s3vectors_vector_bucket.manuals.vector_bucket_arn, aws_s3vectors_index.manuals.index_arn]
  }
}

resource "aws_iam_role" "kb" {
  name               = "${var.name_prefix}-knowledge-base"
  assume_role_policy = data.aws_iam_policy_document.kb_trust.json
}

resource "aws_iam_role_policy" "kb" {
  role   = aws_iam_role.kb.id
  policy = data.aws_iam_policy_document.kb.json
}

# ---------- Knowledge base and data source ----------
resource "aws_bedrockagent_knowledge_base" "manuals" {
  name        = "${var.name_prefix}-manuals"
  description = "HomeLedger appliance manuals, chunked and embedded for ask_manual retrieval."
  role_arn    = aws_iam_role.kb.arn

  knowledge_base_configuration {
    type = "VECTOR"
    vector_knowledge_base_configuration {
      embedding_model_arn = local.embedding_model_arn
    }
  }

  storage_configuration {
    type = "S3_VECTORS"
    s3_vectors_configuration {
      index_arn = aws_s3vectors_index.manuals.index_arn
    }
  }

  depends_on = [aws_iam_role_policy.kb]
}

resource "aws_bedrockagent_data_source" "manuals" {
  name              = "${var.name_prefix}-manuals-s3"
  knowledge_base_id = aws_bedrockagent_knowledge_base.manuals.id

  data_source_configuration {
    type = "S3"
    s3_configuration {
      bucket_arn         = aws_s3_bucket.manuals.arn
      inclusion_prefixes = [local.manuals_prefix]
    }
  }
}

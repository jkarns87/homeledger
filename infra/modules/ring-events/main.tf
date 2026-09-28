data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id      = data.aws_caller_identity.current.account_id
  region          = data.aws_region.current.region
  snapshot_bucket = "${var.name_prefix}-snapshots-${local.account_id}"
  ws_stage        = "demo"

  # Spec §3's secrets table. Values are ARNs; handlers receive them as secret ids.
  secret_arns = {
    client_secret = var.ring_client_secret_arn
    hmac          = var.ring_hmac_key_arn
    tokens        = aws_secretsmanager_secret.tokens.arn
    anthropic     = var.anthropic_key_arn
    passphrase    = var.link_passphrase_arn
  }
}

# ---------- Snapshot bucket (spec §5): images stored byte-for-byte, private ----------
resource "aws_s3_bucket" "snapshots" {
  bucket        = local.snapshot_bucket
  force_destroy = var.snapshot_bucket_force_destroy
}

resource "aws_s3_bucket_public_access_block" "snapshots" {
  bucket                  = aws_s3_bucket.snapshots.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "snapshots" {
  bucket = aws_s3_bucket.snapshots.id
  versioning_configuration {
    status = "Enabled"
  }
}

# trivy:ignore:AVD-AWS-0132 SSE-S3 is sufficient for demo snapshots; a CMK adds cost and a key policy without changing who can read them.
resource "aws_s3_bucket_server_side_encryption_configuration" "snapshots" {
  bucket = aws_s3_bucket.snapshots.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_policy" "snapshots" {
  bucket = aws_s3_bucket.snapshots.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.snapshots.arn, "${aws_s3_bucket.snapshots.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

# ---------- The tokens secret: a container only. Values are written by the link and refresh functions and never enter state (R7). ----------
resource "aws_secretsmanager_secret" "tokens" {
  name                    = "${var.name_prefix}/ring/tokens"
  description             = "Ring access and refresh tokens for the linked account - written by the link and token-refresh functions"
  recovery_window_in_days = var.secret_recovery_window_in_days
}

# ---------- The bus ----------
resource "aws_cloudwatch_event_bus" "this" {
  name = var.name_prefix
}

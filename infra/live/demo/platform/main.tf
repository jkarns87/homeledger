data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id   = data.aws_caller_identity.current.account_id
  region       = data.aws_region.current.region
  name_prefix  = "${var.env}-homeledger"
  runtime_name = "${replace(local.name_prefix, "-", "_")}_mcp"
}

# ---------- ECR ----------
# trivy:ignore:AVD-AWS-0031 MUTABLE is deliberate: the deploy workflow re-pushes the same commit SHA tag on re-runs, which IMMUTABLE rejects; images are addressed by SHA tag in Terraform, never by :latest.
resource "aws_ecr_repository" "mcp" {
  name                 = "${local.name_prefix}-mcp"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
  image_scanning_configuration { scan_on_push = true }
}

resource "aws_ecr_lifecycle_policy" "mcp" {
  repository = aws_ecr_repository.mcp.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "keep last 20 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 20 }
      action       = { type = "expire" }
    }]
  })
}

# ---------- DynamoDB ----------
resource "aws_dynamodb_table" "homeledger" {
  name         = local.name_prefix
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"
  range_key    = "SK"

  attribute {
    name = "PK"
    type = "S"
  }
  attribute {
    name = "SK"
    type = "S"
  }
  attribute {
    name = "GSI1PK"
    type = "S"
  }
  attribute {
    name = "GSI1SK"
    type = "S"
  }
  attribute {
    name = "GSI2PK"
    type = "S"
  }
  attribute {
    name = "GSI2SK"
    type = "S"
  }

  global_secondary_index {
    name            = "GSI1"
    hash_key        = "GSI1PK"
    range_key       = "GSI1SK"
    projection_type = "ALL"
  }
  global_secondary_index {
    name            = "GSI2"
    hash_key        = "GSI2PK"
    range_key       = "GSI2SK"
    projection_type = "ALL"
  }

  # Push connection rows (CONN#) expire on their own (Plan 4 Task 3).
  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery { enabled = true }
}

# ---------- Cognito (JWT issuer for the AgentCore authorizer) ----------
module "cognito" {
  source = "../../../modules/cognito-m2m"

  name                          = "${local.name_prefix}-mcp"
  domain_prefix                 = "${local.name_prefix}-${local.account_id}"
  resource_server_identifier    = "homeledger"
  scope_name                    = "mcp"
  scope_description             = "Call the HomeLedger MCP server"
  client_name                   = "homeledger-simulator"
  access_token_validity_minutes = 60
  secret_name                   = "${local.name_prefix}/cognito/client-secret"

  # The demo opts in to immediate, unrecoverable secret deletion. The module
  # defaults to 30 (AWS's default) for everyone else. See the warning on
  # var.secret_recovery_window_in_days below, and the longer one at
  # infra/modules/cognito-m2m/main.tf's aws_secretsmanager_secret.this.
  recovery_window_in_days = var.secret_recovery_window_in_days
}

# ---------- Manuals, S3 Vectors, and the Bedrock Knowledge Base ----------
module "knowledge_base" {
  source = "../../../modules/knowledge-base"

  name_prefix         = local.name_prefix
  household_id        = var.household_id
  embedding_model_arn = var.embedding_model_arn
}

# ---------- Multi round-trip requestState signing key ----------
# book_service carries booking state across elicitation rounds in a signed,
# client-echoed requestState. Every microVM that may serve a later round needs
# the same key, so it is generated once here rather than per process.
#
# random_password keeps its value in Terraform state by construction, so the
# Secrets Manager copy exists for consumers (the Plan 3 simulator) rather than
# to hide it from state; the version is written with the write-only argument so
# it is not duplicated into that resource's own state as well.
resource "random_password" "request_state" {
  length  = 48
  special = false
}

resource "aws_secretsmanager_secret" "request_state" {
  name = "${local.name_prefix}/mcp/request-state-key"

  # DEMO-ONLY. WRONG FOR PRODUCTION, and wrong in a way that loses data rather
  # than costing money: 0 makes the AWS provider call DeleteSecret with
  # ForceDeleteWithoutRecovery=true, so a destroy deletes this secret outright
  # with no restore path. It is correct here because the value is a
  # random_password regenerated on every apply and nothing outside this stack
  # holds a copy, and it is necessary here because the alternative - the
  # provider's 30-day default - leaves the secret merely *scheduled* for
  # deletion with its NAME still reserved, and the next apply of this same root
  # then fails with "You can't create this secret because a secret with this
  # name is already scheduled for deletion". Tear the demo down in October and
  # that is what blocks bringing it back for judging in November.
  #
  # A production root must not copy this line. Use 7-30 there and accept that a
  # destroy is not a round trip.
  recovery_window_in_days = var.secret_recovery_window_in_days
}

resource "aws_secretsmanager_secret_version" "request_state" {
  secret_id                = aws_secretsmanager_secret.request_state.id
  secret_string_wo         = random_password.request_state.result
  secret_string_wo_version = 1
}

# ---------- Ring (Plan 4) ----------
# Owner-created secrets, read by reference so a destroy can never delete them
# and their values never enter state (spec §3, Plan 4 R7).
data "aws_secretsmanager_secret" "ring_client_secret" {
  name = "${local.name_prefix}/ring/client-secret"
}

data "aws_secretsmanager_secret" "ring_hmac_key" {
  name = "${local.name_prefix}/ring/hmac-key"
}

data "aws_secretsmanager_secret" "anthropic_key" {
  name = "${local.name_prefix}/anthropic/api-key"
}

data "aws_secretsmanager_secret" "link_passphrase" {
  name = "${local.name_prefix}/ring/link-passphrase"
}

module "ring_events" {
  source = "../../../modules/ring-events"

  name_prefix            = local.name_prefix
  household_id           = var.household_id
  table_name             = aws_dynamodb_table.homeledger.name
  table_arn              = aws_dynamodb_table.homeledger.arn
  artifacts_dir          = var.events_artifacts_dir
  ring_client_id         = var.ring_client_id
  ring_client_secret_arn = data.aws_secretsmanager_secret.ring_client_secret.arn
  ring_hmac_key_arn      = data.aws_secretsmanager_secret.ring_hmac_key.arn
  anthropic_key_arn      = data.aws_secretsmanager_secret.anthropic_key.arn
  link_passphrase_arn    = data.aws_secretsmanager_secret.link_passphrase.arn
  cognito_user_pool_id   = module.cognito.user_pool_id
  cognito_client_id      = module.cognito.client_id
  sensors_enabled        = var.sensors_enabled
  sensor_appliance_id    = var.sensor_appliance_id

  secret_recovery_window_in_days = var.secret_recovery_window_in_days
}

# ---------- AgentCore Runtime (execution role + runtime) ----------
module "agentcore_runtime" {
  source = "../../../modules/agentcore-runtime"

  name               = local.runtime_name
  image_uri          = var.image_uri
  role_name          = "${local.name_prefix}-agentcore-runtime"
  ecr_repository_arn = aws_ecr_repository.mcp.arn
  dynamodb_table_arn = aws_dynamodb_table.homeledger.arn

  environment_variables = {
    HOUSEHOLD_ID          = var.household_id
    TABLE_NAME            = aws_dynamodb_table.homeledger.name
    AWS_REGION            = local.region
    HOMELEDGER_DEV_TOOLS  = var.dev_tools_enabled ? "1" : "0"
    ALLOWED_HOSTS         = var.allowed_hosts
    PORT                  = "8000"
    KNOWLEDGE_BASE_ID     = module.knowledge_base.knowledge_base_id
    REQUEST_STATE_KEY     = random_password.request_state.result
    AVAILABILITY_DELAY_MS = tostring(var.availability_delay_ms)
    SNAPSHOT_BUCKET       = module.ring_events.snapshot_bucket
    SNAPSHOT_ORIGIN       = module.ring_events.snapshot_origin
  }

  jwt_discovery_url            = module.cognito.discovery_url
  jwt_allowed_client_ids       = [module.cognito.client_id]
  idle_session_timeout_seconds = var.idle_session_timeout_seconds
  knowledge_base_arn           = module.knowledge_base.knowledge_base_arn
  snapshot_bucket_arn          = module.ring_events.snapshot_bucket_arn
}

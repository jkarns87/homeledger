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
    HOUSEHOLD_ID         = var.household_id
    TABLE_NAME           = aws_dynamodb_table.homeledger.name
    AWS_REGION           = local.region
    HOMELEDGER_DEV_TOOLS = var.dev_tools_enabled ? "1" : "0"
    ALLOWED_HOSTS        = var.allowed_hosts
    PORT                 = "8000"
  }

  jwt_discovery_url            = module.cognito.discovery_url
  jwt_allowed_client_ids       = [module.cognito.client_id]
  idle_session_timeout_seconds = var.idle_session_timeout_seconds
}

data "aws_region" "current" {}

locals {
  region = data.aws_region.current.region
  scope  = "${var.resource_server_identifier}/${var.scope_name}"
}

resource "aws_cognito_user_pool" "this" {
  name = var.name
}

resource "aws_cognito_user_pool_domain" "this" {
  domain       = var.domain_prefix
  user_pool_id = aws_cognito_user_pool.this.id
}

resource "aws_cognito_resource_server" "this" {
  identifier   = var.resource_server_identifier
  name         = var.name
  user_pool_id = aws_cognito_user_pool.this.id
  scope {
    scope_name        = var.scope_name
    scope_description = var.scope_description
  }
}

resource "aws_cognito_user_pool_client" "this" {
  name                                 = var.client_name
  user_pool_id                         = aws_cognito_user_pool.this.id
  generate_secret                      = true
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["client_credentials"]
  allowed_oauth_scopes                 = [local.scope]
  supported_identity_providers         = ["COGNITO"]
  access_token_validity                = var.access_token_validity_minutes
  token_validity_units { access_token = "minutes" }
  depends_on = [aws_cognito_resource_server.this]
}

# The client secret is written with the write-only secret_string_wo argument
# so Cognito's value is not duplicated into this resource's own state;
# secret_string_wo_version must change to push a new value on a future
# apply (it stays 1 here because the client secret itself never changes
# without recreating the client).
resource "aws_secretsmanager_secret" "this" {
  name = var.secret_name
}

resource "aws_secretsmanager_secret_version" "this" {
  secret_id                = aws_secretsmanager_secret.this.id
  secret_string_wo         = aws_cognito_user_pool_client.this.client_secret
  secret_string_wo_version = 1
}

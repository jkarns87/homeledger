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

  # READ THIS BEFORE COPYING THIS MODULE SOMEWHERE THAT IS NOT DISPOSABLE.
  #
  # This argument decides what `terraform destroy` does to the secret, and the
  # two outcomes are not variations on a theme:
  #
  #   30 (this module's default, and AWS's own)
  #     DeleteSecret schedules the secret and stamps a DeletionDate 30 days out.
  #     The value stays restorable with `aws secretsmanager restore-secret` for
  #     the whole window. It also keeps the NAME reserved for the whole window,
  #     so re-applying this module with the same secret_name inside it fails
  #     with "You can't create this secret because a secret with this name is
  #     already scheduled for deletion".
  #
  #   0
  #     The AWS provider sends DeleteSecret with ForceDeleteWithoutRecovery=true
  #     instead of RecoveryWindowInDays. The secret is deleted outright and
  #     there is NO restore - "you have no opportunity to recover the secret.
  #     You lose the secret permanently" (DeleteSecret API reference). The name
  #     frees up, so a destroy/re-apply round trip works.
  #
  # The default is 30 because a production caller wants the recovery window and
  # is not doing round trips. HomeLedger's demo root opts in to 0 in
  # infra/live/demo/platform/main.tf, where the value is regenerated on every
  # apply and losing it costs nothing. Do not move that opt-in up here.
  recovery_window_in_days = var.recovery_window_in_days
}

resource "aws_secretsmanager_secret_version" "this" {
  secret_id                = aws_secretsmanager_secret.this.id
  secret_string_wo         = aws_cognito_user_pool_client.this.client_secret
  secret_string_wo_version = 1
}

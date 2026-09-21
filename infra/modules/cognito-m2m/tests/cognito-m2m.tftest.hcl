mock_provider "aws" {}

variables {
  name                       = "demo-homeledger-mcp"
  domain_prefix              = "demo-homeledger-123456789012"
  resource_server_identifier = "homeledger"
  scope_name                 = "mcp"
  scope_description          = "Call the HomeLedger MCP server"
  client_name                = "homeledger-simulator"
  secret_name                = "demo-homeledger/cognito/client-secret"
}

run "client_has_client_credentials_flow_and_scope" {
  command = plan

  assert {
    condition     = contains(aws_cognito_user_pool_client.this.allowed_oauth_flows, "client_credentials")
    error_message = "client must allow the client_credentials flow"
  }

  assert {
    condition     = contains(aws_cognito_user_pool_client.this.allowed_oauth_scopes, "homeledger/mcp")
    error_message = "client must be scoped to homeledger/mcp"
  }

  assert {
    condition     = aws_cognito_user_pool_client.this.generate_secret == true
    error_message = "client must generate a secret"
  }
}

run "scope_output_matches_identifier_and_scope_name" {
  command = plan

  assert {
    condition     = output.scope == "homeledger/mcp"
    error_message = "scope output must be \"identifier/scope_name\""
  }
}

run "rejects_out_of_range_token_validity" {
  command = plan

  variables {
    access_token_validity_minutes = 0
  }

  expect_failures = [var.access_token_validity_minutes]
}

# ---------------------------------------------------------------------------
# Secret deletion semantics.
#
# recovery_window_in_days decides what `terraform destroy` does to the client
# secret, and the consequence that matters is not about the value - it is about
# the NAME. A nonzero window leaves the secret merely scheduled, with its name
# reserved for the whole window, and a later apply of the same configuration
# fails with "You can't create this secret because a secret with this name is
# already scheduled for deletion". 0 makes the provider send DeleteSecret with
# ForceDeleteWithoutRecovery=true, which deletes outright and frees the name.
#
# This module is reusable, so its default is the production-safe 30 and the
# opt-in to 0 belongs to the calling root. The three runs below pin the default,
# the opt-in, and the boundary AWS enforces between them.
# ---------------------------------------------------------------------------

run "secret_recovery_window_defaults_to_the_production_safe_thirty_days" {
  command = plan

  assert {
    condition     = output.secret_recovery_window_in_days == 30
    error_message = "a caller that says nothing must get AWS's own 30-day recovery window, not immediate deletion: this module is reusable and an unrecoverable destroy must never be what a copy of it does by default"
  }
}

run "a_caller_can_opt_in_to_immediate_unrecoverable_deletion" {
  command = plan

  variables {
    recovery_window_in_days = 0
  }

  assert {
    condition     = output.secret_recovery_window_in_days == 0
    error_message = "recovery_window_in_days must reach aws_secretsmanager_secret.this rather than being declared and dropped; at 0 the provider sends ForceDeleteWithoutRecovery=true and the secret's name frees up for a re-apply"
  }
}

run "rejects_a_recovery_window_aws_will_not_accept" {
  command = plan

  variables {
    recovery_window_in_days = 3
  }

  expect_failures = [var.recovery_window_in_days]
}

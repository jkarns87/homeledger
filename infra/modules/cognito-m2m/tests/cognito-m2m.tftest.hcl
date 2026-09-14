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

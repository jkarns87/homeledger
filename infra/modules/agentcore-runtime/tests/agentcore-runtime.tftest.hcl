mock_provider "aws" {
  override_data {
    target = data.aws_iam_policy_document.trust
    values = {
      json = jsonencode({ Version = "2012-10-17", Statement = [] })
    }
  }

  override_data {
    target = data.aws_iam_policy_document.this
    values = {
      json = jsonencode({ Version = "2012-10-17", Statement = [] })
    }
  }
}

variables {
  name               = "homeledger_mcp"
  role_name          = "homeledger-agentcore-runtime"
  ecr_repository_arn = "arn:aws:ecr:us-east-1:123456789012:repository/homeledger-mcp"
  dynamodb_table_arn = "arn:aws:dynamodb:us-east-1:123456789012:table/homeledger"
  environment_variables = {
    HOUSEHOLD_ID = "hh_harlow"
  }
  jwt_discovery_url            = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc123/.well-known/openid-configuration"
  jwt_allowed_client_ids       = ["abc123clientid"]
  idle_session_timeout_seconds = 1800
}

run "no_runtime_without_image" {
  command = plan

  assert {
    condition     = length(aws_bedrockagentcore_agent_runtime.this) == 0
    error_message = "the runtime must not be created when image_uri is empty"
  }

  assert {
    condition     = output.agent_runtime_arn == ""
    error_message = "agent_runtime_arn output must be empty when no runtime is created"
  }

  assert {
    condition     = output.invocation_url == ""
    error_message = "invocation_url output must be empty when no runtime is created"
  }
}

run "runtime_created_with_image" {
  command = plan

  variables {
    image_uri = "123456789012.dkr.ecr.us-east-1.amazonaws.com/homeledger-mcp:abc1234"
  }

  assert {
    condition     = length(aws_bedrockagentcore_agent_runtime.this) == 1
    error_message = "the runtime must be created when image_uri is set"
  }

  assert {
    condition     = aws_bedrockagentcore_agent_runtime.this[0].protocol_configuration[0].server_protocol == "MCP"
    error_message = "the runtime must speak MCP"
  }
}

run "rejects_bad_name" {
  command = plan

  variables {
    name = "bad name!"
  }

  expect_failures = [var.name]
}

run "rejects_out_of_range_idle_timeout" {
  command = plan

  variables {
    idle_session_timeout_seconds = 30
  }

  expect_failures = [var.idle_session_timeout_seconds]
}

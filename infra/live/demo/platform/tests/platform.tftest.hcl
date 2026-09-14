mock_provider "aws" {
  override_data {
    target = module.agentcore_runtime.data.aws_iam_policy_document.trust
    values = {
      json = jsonencode({ Version = "2012-10-17", Statement = [] })
    }
  }

  override_data {
    target = module.agentcore_runtime.data.aws_iam_policy_document.this
    values = {
      json = jsonencode({ Version = "2012-10-17", Statement = [] })
    }
  }

  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "123456789012"
    }
  }

  override_resource {
    target = module.agentcore_runtime.aws_iam_role.this
    values = {
      arn = "arn:aws:iam::123456789012:role/demo-homeledger-agentcore-runtime"
    }
  }
}

run "table_has_both_gsis_with_all_projection" {
  command = plan

  assert {
    condition     = aws_dynamodb_table.homeledger.hash_key == "PK" && aws_dynamodb_table.homeledger.range_key == "SK"
    error_message = "table must be keyed on PK/SK"
  }

  assert {
    condition = alltrue([
      for gsi in aws_dynamodb_table.homeledger.global_secondary_index : gsi.projection_type == "ALL"
    ])
    error_message = "every GSI must project ALL attributes"
  }

  assert {
    condition     = length([for gsi in aws_dynamodb_table.homeledger.global_secondary_index : gsi.name if gsi.name == "GSI1" && gsi.hash_key == "GSI1PK" && gsi.range_key == "GSI1SK"]) == 1
    error_message = "GSI1 must be keyed on GSI1PK/GSI1SK"
  }

  assert {
    condition     = length([for gsi in aws_dynamodb_table.homeledger.global_secondary_index : gsi.name if gsi.name == "GSI2" && gsi.hash_key == "GSI2PK" && gsi.range_key == "GSI2SK"]) == 1
    error_message = "GSI2 must be keyed on GSI2PK/GSI2SK"
  }
}

run "no_runtime_without_image" {
  command = plan

  assert {
    condition     = output.agent_runtime_arn == ""
    error_message = "agent_runtime_arn must be empty on the first apply (no image_uri)"
  }

  assert {
    condition     = output.agent_runtime_invocation_url == ""
    error_message = "agent_runtime_invocation_url must be empty on the first apply (no image_uri)"
  }
}

run "runtime_created_with_image" {
  # apply: agent_runtime_arn is computed by the provider and unknown at plan
  # time for a resource being created; mock_provider fabricates it on apply
  # without touching real AWS.
  command = apply

  variables {
    image_uri = "123456789012.dkr.ecr.us-east-1.amazonaws.com/homeledger-mcp:abc1234"
  }

  assert {
    condition     = length(module.agentcore_runtime.agent_runtime_arn) > 0
    error_message = "agent_runtime_arn must be non-empty once image_uri is set"
  }

  assert {
    condition     = output.deployed_image_uri == "123456789012.dkr.ecr.us-east-1.amazonaws.com/homeledger-mcp:abc1234"
    error_message = "deployed_image_uri must echo back the image_uri this run was applied with, so a PR plan job that reads it back as -var image_uri never plans a runtime destroy"
  }
}

run "outputs_are_wired_and_non_empty" {
  # apply: several of these outputs come from provider-computed attributes
  # (repository_url, discovery_url, secret arn) that are unknown at plan
  # time for resources being created.
  command = apply

  assert {
    condition     = output.ecr_repository_url != null && output.ecr_repository_url != ""
    error_message = "ecr_repository_url must be set"
  }

  assert {
    condition     = output.table_name == "demo-homeledger"
    error_message = "table_name must follow the env-homeledger naming convention"
  }

  assert {
    condition     = output.cognito_discovery_url != null && output.cognito_discovery_url != ""
    error_message = "cognito_discovery_url must be set"
  }

  assert {
    condition     = output.cognito_client_secret_arn != null && output.cognito_client_secret_arn != ""
    error_message = "cognito_client_secret_arn must be set"
  }
}

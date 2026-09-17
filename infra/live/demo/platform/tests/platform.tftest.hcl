mock_provider "random" {}

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

  override_data {
    target = module.knowledge_base.data.aws_iam_policy_document.kb_trust
    values = {
      json = jsonencode({ Version = "2012-10-17", Statement = [] })
    }
  }

  override_data {
    target = module.knowledge_base.data.aws_iam_policy_document.kb
    values = {
      json = jsonencode({ Version = "2012-10-17", Statement = [] })
    }
  }

  override_resource {
    target = module.agentcore_runtime.aws_iam_role.this
    values = {
      arn = "arn:aws:iam::123456789012:role/demo-homeledger-agentcore-runtime"
    }
  }

  override_resource {
    target = module.knowledge_base.aws_iam_role.kb
    values = {
      arn = "arn:aws:iam::123456789012:role/demo-homeledger-knowledge-base"
    }
  }

  override_resource {
    target = module.knowledge_base.aws_s3vectors_index.manuals
    values = {
      index_arn = "arn:aws:s3vectors:us-east-1:123456789012:bucket/demo-homeledger-vectors/index/manuals"
    }
  }

  override_resource {
    target = module.knowledge_base.aws_s3_bucket.manuals
    values = {
      arn = "arn:aws:s3:::demo-homeledger-manuals-123456789012"
    }
  }

  override_resource {
    target = module.knowledge_base.aws_bedrockagent_knowledge_base.manuals
    values = {
      id = "KB1234567890"
    }
  }

  # module.knowledge_base has its own data.aws_caller_identity.current
  # instance (distinct from the root's, overridden above), which the
  # manuals bucket name is built from. Overriding it to the same account id
  # makes that bucket name an exact, configuration-determined string rather
  # than a mock-fabricated one, so knowledge_base_is_wired_into_the_runtime
  # can assert on it precisely instead of only on non-emptiness.
  override_data {
    target = module.knowledge_base.data.aws_caller_identity.current
    values = {
      account_id = "123456789012"
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

run "dev_tools_disabled_sets_env_var_to_zero" {
  # apply: environment_variables is echoed back by the provider on the
  # created resource, unknown at plan time the same way agent_runtime_arn is
  # in runtime_created_with_image above.
  command = apply

  variables {
    image_uri         = "123456789012.dkr.ecr.us-east-1.amazonaws.com/homeledger-mcp:abc1234"
    dev_tools_enabled = false
  }

  assert {
    condition     = module.agentcore_runtime.environment_variables["HOMELEDGER_DEV_TOOLS"] == "0"
    error_message = "HOMELEDGER_DEV_TOOLS must be \"0\" when dev_tools_enabled is false"
  }
}

run "knowledge_base_is_wired_into_the_runtime" {
  # apply: knowledge_base_id and the secret arn are provider-computed and
  # unknown at plan time for resources being created.
  command = apply

  variables {
    image_uri = "123456789012.dkr.ecr.us-east-1.amazonaws.com/homeledger-mcp:abc1234"
  }

  # The knowledge base's id is fixed by override_resource above, so this
  # asserts the output is wired to THAT resource's id specifically, not
  # merely that some mock-fabricated string made it through non-empty.
  assert {
    condition     = output.knowledge_base_id == "KB1234567890"
    error_message = "knowledge_base_id must echo the knowledge base resource's id"
  }

  assert {
    condition     = output.manuals_prefix == "manuals/hh_harlow/"
    error_message = "the manuals prefix must be scoped to the household"
  }

  # manuals_bucket is built entirely from configuration
  # (name_prefix-manuals-account_id); with module.knowledge_base's own
  # aws_caller_identity data source pinned above, the exact string is
  # knowable, so assert it rather than only its non-emptiness.
  assert {
    condition     = output.manuals_bucket == "demo-homeledger-manuals-123456789012"
    error_message = "manuals_bucket must follow the name_prefix-manuals-account_id convention"
  }
}

run "rejects_an_out_of_range_availability_delay" {
  command = plan

  variables {
    availability_delay_ms = 5000
  }

  expect_failures = [var.availability_delay_ms]
}

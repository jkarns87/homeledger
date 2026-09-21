# The teardown / bring-up round trip that .github/workflows/teardown.yml drives.
#
# Why this is its own file rather than three more runs appended to
# platform.tftest.hcl, which is where they started: every `run` in a file shares
# one state, and a run that errors skips every run after it. platform.tftest.hcl
# already exercises the image_uri lever incidentally - `runtime_created_with_image`
# applies with an image and `outputs_are_wired_and_non_empty` applies without one
# straight after, which is a teardown nobody asserts on - so any mutation that
# breaks the lever errors there first and skips the round trip entirely. The
# round-trip assertions were therefore unfailable where they were: not wrong,
# just never reached. Verified rather than assumed - `prevent_destroy = true` on
# aws_bedrockagentcore_agent_runtime.this failed run 4 of 13 and skipped the
# other 9, the round trip included.
#
# In its own file the round trip gets its own state and is the first thing to
# touch the lever, so the same mutation lands on the assertion that is about it.
#
# The mock_provider block is a copy of platform.tftest.hcl's, minus the two
# override_resource entries that only exist to pin values for assertions that
# live over there. Mocks are per-file in Terraform test and there is no include
# mechanism for them.

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
    target = module.knowledge_base.data.aws_caller_identity.current
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
}

variables {
  image_uri = "123456789012.dkr.ecr.us-east-1.amazonaws.com/homeledger-mcp:abc1234"
}

# Start from a deployed stack. Without this the teardown below would be
# indistinguishable from a first apply that never had a runtime, which
# platform.tftest.hcl's `no_runtime_without_image` already covers.
run "step_1_the_stack_is_deployed" {
  command = apply

  assert {
    condition     = output.agent_runtime_arn != "" && output.agent_runtime_invocation_url != ""
    error_message = "the round trip has to start from a deployed runtime or the teardown below proves nothing"
  }
}

# The teardown the workflow performs: an apply with an empty image_uri, not a
# destroy. `count = var.image_uri == "" ? 0 : 1` on the runtime is the only
# conditional in the whole configuration, which is why this removes exactly one
# resource and why the workflow has no way to express a wider operation.
run "step_2_an_empty_image_uri_removes_the_runtime_from_a_deployed_stack" {
  command = apply

  variables {
    image_uri = ""
  }

  assert {
    condition     = output.agent_runtime_arn == "" && output.agent_runtime_invocation_url == ""
    error_message = "applying with image_uri=\"\" over a deployed stack must remove the runtime; this is the only lever .github/workflows/teardown.yml has"
  }
}

# Bring-up: the same lever, pushed the other way, against the state the teardown
# left. This is the run that distinguishes "the runtime can be created" from
# "the runtime can be re-created", and the second is what a November bring-up
# needs.
run "step_3_supplying_the_image_uri_again_restores_the_runtime" {
  command = apply

  assert {
    condition     = output.agent_runtime_arn != "" && output.agent_runtime_invocation_url != ""
    error_message = "bring-up must put the runtime back after a teardown, so image_uri works in both directions rather than only on a stack that never had one"
  }

  assert {
    condition     = output.deployed_image_uri == "123456789012.dkr.ecr.us-east-1.amazonaws.com/homeledger-mcp:abc1234"
    error_message = "bring-up must redeploy the image URI it was given - the one teardown recorded - rather than whatever the last apply happened to leave in state"
  }
}

# Nothing in this file asserts that the Cognito client id, the Knowledge Base id
# or any other provider-computed identifier survives the round trip, and that is
# a deliberate omission rather than an oversight. It was written, run, and
# removed: under mock_provider a replaced resource is handed the SAME fabricated
# id as the one it replaced, so `output.cognito_client_id ==
# run.step_1_the_stack_is_deployed.cognito_client_id` passes even when the app
# client is genuinely destroyed and recreated. Proved by mutating `client_name`
# in main.tf to depend on var.image_uri - a ForceNew attribute, so teardown
# replaces the client - after which every run stayed green.
#
# An assertion that cannot fail is worse than none, so the claim is recorded as
# unproven-offline instead. What holds it in reality is structural: no resource
# in this root except the runtime has a `count`, and none of them reads
# var.image_uri. The teardown workflow's own plan guard is what checks that on
# the day, against the real provider, before it applies anything.

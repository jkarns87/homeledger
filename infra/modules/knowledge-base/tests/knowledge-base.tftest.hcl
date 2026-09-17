mock_provider "aws" {
  override_data {
    target = data.aws_iam_policy_document.kb_trust
    values = {
      json = jsonencode({ Version = "2012-10-17", Statement = [] })
    }
  }

  override_data {
    target = data.aws_iam_policy_document.kb
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
}

variables {
  name_prefix  = "demo-homeledger"
  household_id = "hh_harlow"
}

run "manuals_bucket_is_private_and_versioned" {
  command = plan

  assert {
    condition     = aws_s3_bucket_public_access_block.manuals.block_public_acls && aws_s3_bucket_public_access_block.manuals.block_public_policy && aws_s3_bucket_public_access_block.manuals.ignore_public_acls && aws_s3_bucket_public_access_block.manuals.restrict_public_buckets
    error_message = "the manuals bucket must block all public access"
  }

  assert {
    condition     = aws_s3_bucket_versioning.manuals.versioning_configuration[0].status == "Enabled"
    error_message = "the manuals bucket must be versioned"
  }
}

run "knowledge_base_uses_s3_vectors_and_titan" {
  command = plan

  assert {
    condition     = aws_bedrockagent_knowledge_base.manuals.storage_configuration[0].type == "S3_VECTORS"
    error_message = "the knowledge base must store vectors in S3 Vectors"
  }

  assert {
    condition     = aws_bedrockagent_knowledge_base.manuals.knowledge_base_configuration[0].type == "VECTOR"
    error_message = "the knowledge base must be a VECTOR knowledge base"
  }

  assert {
    condition     = endswith(local.embedding_model_arn, "amazon.titan-embed-text-v2:0")
    error_message = "the default embedding model must be Titan Text Embeddings v2"
  }
}

run "data_source_ingests_only_this_household" {
  command = plan

  assert {
    condition     = aws_bedrockagent_data_source.manuals.data_source_configuration[0].s3_configuration[0].inclusion_prefixes == toset(["manuals/hh_harlow/"])
    error_message = "the data source must ingest only this household's manuals prefix"
  }
}

run "index_dimension_matches_the_embedding_model" {
  command = plan

  assert {
    condition     = aws_s3vectors_index.manuals.dimension == 1024
    error_message = "the vector index dimension must match Titan Text Embeddings v2"
  }
}

run "rejects_a_bad_dimension" {
  command = plan

  variables {
    vector_dimension = 768
  }

  expect_failures = [var.vector_dimension]
}

run "rejects_a_bad_household_id" {
  command = plan

  variables {
    household_id = "harlow"
  }

  expect_failures = [var.household_id]
}

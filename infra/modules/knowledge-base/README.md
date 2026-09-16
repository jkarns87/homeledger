# knowledge-base

Manuals bucket, S3 Vectors bucket and index, Bedrock Knowledge Base with an S3 data source, and the knowledge base service role. Manuals live at `manuals/<household_id>/<docId>.pdf` with a sidecar `<docId>.pdf.metadata.json` carrying `applianceId` and `title`; `ask_manual` filters on `applianceId` through that metadata.

<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
| ---- | ------- |
| <a name="requirement_terraform"></a> [terraform](#requirement\_terraform) | >= 1.10.0 |
| <a name="requirement_aws"></a> [aws](#requirement\_aws) | >= 6.21.0, < 7.0.0 |

## Providers

| Name | Version |
| ---- | ------- |
| <a name="provider_aws"></a> [aws](#provider\_aws) | 6.64.0 |

## Modules

No modules.

## Resources

| Name | Type |
| ---- | ---- |
| [aws_bedrockagent_data_source.manuals](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagent_data_source) | resource |
| [aws_bedrockagent_knowledge_base.manuals](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagent_knowledge_base) | resource |
| [aws_iam_role.kb](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role) | resource |
| [aws_iam_role_policy.kb](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role_policy) | resource |
| [aws_s3_bucket.manuals](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/s3_bucket) | resource |
| [aws_s3_bucket_public_access_block.manuals](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/s3_bucket_public_access_block) | resource |
| [aws_s3_bucket_server_side_encryption_configuration.manuals](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/s3_bucket_server_side_encryption_configuration) | resource |
| [aws_s3_bucket_versioning.manuals](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/s3_bucket_versioning) | resource |
| [aws_s3vectors_index.manuals](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/s3vectors_index) | resource |
| [aws_s3vectors_vector_bucket.manuals](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/s3vectors_vector_bucket) | resource |
| [aws_caller_identity.current](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/caller_identity) | data source |
| [aws_iam_policy_document.kb](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/iam_policy_document) | data source |
| [aws_iam_policy_document.kb_trust](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/iam_policy_document) | data source |
| [aws_region.current](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/region) | data source |

## Inputs

| Name | Description | Type | Default | Required |
| ---- | ----------- | ---- | ------- | :------: |
| <a name="input_embedding_model_arn"></a> [embedding\_model\_arn](#input\_embedding\_model\_arn) | ARN of the Bedrock embedding model the knowledge base uses. Titan Text Embeddings v2 by default; it must be enabled in this account and region. | `string` | `""` | no |
| <a name="input_force_destroy"></a> [force\_destroy](#input\_force\_destroy) | Whether the manuals bucket may be destroyed while it still holds objects. True in the demo environment so teardown is one command. | `bool` | `true` | no |
| <a name="input_household_id"></a> [household\_id](#input\_household\_id) | Household id. Manuals live under manuals/<household\_id>/ in the bucket, and the data source ingests only that prefix. | `string` | n/a | yes |
| <a name="input_name_prefix"></a> [name\_prefix](#input\_name\_prefix) | Prefix applied to every resource name in this module, e.g. "demo-homeledger". | `string` | n/a | yes |
| <a name="input_vector_dimension"></a> [vector\_dimension](#input\_vector\_dimension) | Embedding dimension of the S3 Vectors index. Titan Text Embeddings v2 emits 1024 by default and also supports 512 and 256. | `number` | `1024` | no |

## Outputs

| Name | Description |
| ---- | ----------- |
| <a name="output_data_source_id"></a> [data\_source\_id](#output\_data\_source\_id) | Bedrock data source id, used by the manuals ingestion script to start ingestion jobs. |
| <a name="output_knowledge_base_arn"></a> [knowledge\_base\_arn](#output\_knowledge\_base\_arn) | Bedrock Knowledge Base ARN, granted to the runtime execution role for bedrock:Retrieve. |
| <a name="output_knowledge_base_id"></a> [knowledge\_base\_id](#output\_knowledge\_base\_id) | Bedrock Knowledge Base id, passed to the runtime as KNOWLEDGE\_BASE\_ID. |
| <a name="output_manuals_bucket"></a> [manuals\_bucket](#output\_manuals\_bucket) | Name of the S3 bucket holding manual PDFs and their metadata sidecars. |
| <a name="output_manuals_bucket_arn"></a> [manuals\_bucket\_arn](#output\_manuals\_bucket\_arn) | ARN of the manuals bucket. |
| <a name="output_manuals_prefix"></a> [manuals\_prefix](#output\_manuals\_prefix) | Key prefix inside the manuals bucket that the data source ingests. |
| <a name="output_vector_index_arn"></a> [vector\_index\_arn](#output\_vector\_index\_arn) | ARN of the S3 Vectors index backing the knowledge base. |
<!-- END_TF_DOCS -->

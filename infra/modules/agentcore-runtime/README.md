# agentcore-runtime

Creates the IAM execution role AgentCore Runtime assumes to pull the MCP
server's container image, write logs/traces/metrics, mint workload access
tokens, and read/write the HomeLedger DynamoDB table — and, once an image
exists, the `aws_bedrockagentcore_agent_runtime` itself.

## The count idiom

`aws_bedrockagentcore_agent_runtime.this` uses `count = var.image_uri == "" ? 0 : 1`.
The runtime requires an image already pushed to ECR, so callers apply this
module twice: once with the default `image_uri = ""` (creates only the role),
and again after `scripts/build-image.sh` has pushed an image, with
`image_uri` set (creates the runtime). All runtime-shaped outputs
(`agent_runtime_arn`, `invocation_url`, `runtime_id`) are empty strings when
the runtime does not exist.

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
| [aws_bedrockagentcore_agent_runtime.this](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_agent_runtime) | resource |
| [aws_iam_role.this](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role) | resource |
| [aws_iam_role_policy.this](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role_policy) | resource |
| [aws_caller_identity.current](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/caller_identity) | data source |
| [aws_iam_policy_document.this](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/iam_policy_document) | data source |
| [aws_iam_policy_document.trust](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/iam_policy_document) | data source |
| [aws_region.current](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/region) | data source |

## Inputs

| Name | Description | Type | Default | Required |
| ---- | ----------- | ---- | ------- | :------: |
| <a name="input_dynamodb_table_arn"></a> [dynamodb\_table\_arn](#input\_dynamodb\_table\_arn) | ARN of the DynamoDB table the runtime is granted access to (table and its GSIs). | `string` | n/a | yes |
| <a name="input_ecr_repository_arn"></a> [ecr\_repository\_arn](#input\_ecr\_repository\_arn) | ARN of the ECR repository the runtime pulls its container image from. | `string` | n/a | yes |
| <a name="input_environment_variables"></a> [environment\_variables](#input\_environment\_variables) | Environment variables injected into the runtime container. | `map(string)` | `{}` | no |
| <a name="input_idle_session_timeout_seconds"></a> [idle\_session\_timeout\_seconds](#input\_idle\_session\_timeout\_seconds) | Idle runtime session timeout, in seconds. | `number` | n/a | yes |
| <a name="input_image_uri"></a> [image\_uri](#input\_image\_uri) | Full ECR image URI with tag. Empty string means no image is available yet, so the runtime is not created (count = 0). | `string` | `""` | no |
| <a name="input_jwt_allowed_client_ids"></a> [jwt\_allowed\_client\_ids](#input\_jwt\_allowed\_client\_ids) | Client IDs the custom JWT authorizer accepts. | `list(string)` | n/a | yes |
| <a name="input_jwt_discovery_url"></a> [jwt\_discovery\_url](#input\_jwt\_discovery\_url) | OIDC discovery URL for the custom JWT authorizer (Cognito user pool .well-known/openid-configuration). | `string` | n/a | yes |
| <a name="input_max_lifetime_seconds"></a> [max\_lifetime\_seconds](#input\_max\_lifetime\_seconds) | Maximum runtime session lifetime, in seconds, before AgentCore forcibly recycles it. | `number` | `28800` | no |
| <a name="input_name"></a> [name](#input\_name) | AgentCore runtime name. AgentCore restricts this to letters, digits, and underscores. | `string` | n/a | yes |
| <a name="input_network_mode"></a> [network\_mode](#input\_network\_mode) | AgentCore Runtime network mode. | `string` | `"PUBLIC"` | no |
| <a name="input_role_name"></a> [role\_name](#input\_role\_name) | Name for the IAM execution role created for the runtime. | `string` | n/a | yes |

## Outputs

| Name | Description |
| ---- | ----------- |
| <a name="output_agent_runtime_arn"></a> [agent\_runtime\_arn](#output\_agent\_runtime\_arn) | ARN of the AgentCore runtime. Empty string until image\_uri is set and the runtime is created. |
| <a name="output_environment_variables"></a> [environment\_variables](#output\_environment\_variables) | Environment variables applied to the runtime container, for callers (and tests) that need to assert on a specific value. Empty map until the runtime is created. |
| <a name="output_invocation_url"></a> [invocation\_url](#output\_invocation\_url) | HTTPS invocation URL for the runtime's DEFAULT endpoint. Empty string until the runtime is created. |
| <a name="output_role_arn"></a> [role\_arn](#output\_role\_arn) | ARN of the IAM execution role created for the runtime. |
| <a name="output_runtime_id"></a> [runtime\_id](#output\_runtime\_id) | AgentCore runtime id. Empty string until the runtime is created. |
<!-- END_TF_DOCS -->

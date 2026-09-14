# platform

Root module for HomeLedger's demo AWS footprint: ECR repository, DynamoDB
table, Cognito user pool (via the `cognito-m2m` module, JWT issuer for the
AgentCore authorizer), and the AgentCore execution role and runtime (via the
`agentcore-runtime` module). One root equals one state file; later layers
(events, simulator) become sibling roots under `infra/live/demo/`.

## Blast radius

One apply of this root can create, update, or destroy: the `homeledger-mcp`
ECR repository (and every image tag in it, on destroy); the `demo-homeledger`
DynamoDB table (all HomeLedger data for the demo household); the Cognito
user pool, its domain, resource server, and app client; the Secrets Manager
secret holding the client secret; the AgentCore execution IAM role and its
inline policy; and the AgentCore runtime itself. It does not touch the OIDC
provider or GitHub deploy role used to run it — those are managed outside
Terraform.

## Terraform runs only in GitHub Actions

There are no local AWS credentials for Terraform in this repo, by design.
`plan` and `apply` happen only in the `deploy` GitHub Actions workflow (Task
13), which:

1. Assumes the OIDC role `AWS_ROLE_ARN` (a repository variable; the role and
   its trust policy are created and managed outside Terraform).
2. Runs, from repository variables `TF_STATE_BUCKET` and `AWS_REGION`:
   ```bash
   terraform init -backend-config="bucket=$TF_STATE_BUCKET" -backend-config="region=$AWS_REGION"
   ```
3. Builds and pushes the image with `scripts/build-image.sh`.
4. Applies with `-var image_uri=<the pushed image URI>`.

Pull requests get a `terraform plan` only — no apply.

Locally, only formatting, offline validation, and native tests are used:

```bash
cd infra/live/demo/platform
terraform fmt -recursive
terraform fmt -check -recursive
terraform init -backend=false   # downloads the provider only; no backend, no credentials
terraform validate
terraform test
```

Do not run `terraform init` with backend config, `plan`, or `apply` from a
local machine.

## The two-pass apply

`var.image_uri` defaults to `""`. The `agentcore-runtime` module creates its
`aws_bedrockagentcore_agent_runtime` resource with
`count = var.image_uri == "" ? 0 : 1`, so:

- **First apply** (empty `image_uri`, the default): creates the ECR
  repository, the DynamoDB table, the Cognito user pool/domain/resource
  server/client and its Secrets Manager secret, and the IAM execution role —
  everything except the runtime. `agent_runtime_arn` and
  `agent_runtime_invocation_url` are empty strings.
- **Build and push**: `scripts/build-image.sh` builds the `linux/arm64`
  container and pushes it to the ECR repository the first apply created,
  producing an image URI.
- **Second apply** (`-var image_uri=<that URI>`): creates the AgentCore
  runtime pointed at the pushed image. Re-running with a new `image_uri`
  after a rebuild updates the runtime to the new image.

This ordering exists because the runtime resource requires an image already
present in ECR — it cannot be created before the repository has one.

## Naming

Resource names derive from `local.name_prefix = "${var.env}-homeledger"`, so
the server reads its table name from the `table_name` output / `TABLE_NAME`
environment variable rather than any hardcoded string.

## Variables

See `variables.tf` for the full list, defaults, and validation rules.
`demo.tfvars.example` shows the minimal overrides for the demo environment;
copy it to `demo.tfvars` (already git-ignored) for local reference only — it
is not read automatically by the Actions workflow, which passes
`-var image_uri=...` directly.

<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
| ---- | ------- |
| <a name="requirement_terraform"></a> [terraform](#requirement\_terraform) | >= 1.10.0 |
| <a name="requirement_aws"></a> [aws](#requirement\_aws) | ~> 6.21 |

## Providers

| Name | Version |
| ---- | ------- |
| <a name="provider_aws"></a> [aws](#provider\_aws) | 6.64.0 |

## Modules

| Name | Source | Version |
| ---- | ------ | ------- |
| <a name="module_agentcore_runtime"></a> [agentcore\_runtime](#module\_agentcore\_runtime) | ../../../modules/agentcore-runtime | n/a |
| <a name="module_cognito"></a> [cognito](#module\_cognito) | ../../../modules/cognito-m2m | n/a |

## Resources

| Name | Type |
| ---- | ---- |
| [aws_dynamodb_table.homeledger](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/dynamodb_table) | resource |
| [aws_ecr_lifecycle_policy.mcp](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/ecr_lifecycle_policy) | resource |
| [aws_ecr_repository.mcp](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/ecr_repository) | resource |
| [aws_caller_identity.current](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/caller_identity) | data source |
| [aws_region.current](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/region) | data source |

## Inputs

| Name | Description | Type | Default | Required |
| ---- | ----------- | ---- | ------- | :------: |
| <a name="input_allowed_hosts"></a> [allowed\_hosts](#input\_allowed\_hosts) | Comma-separated Host header allowlist passed to the server as ALLOWED\_HOSTS. | `string` | `"localhost,127.0.0.1,0.0.0.0"` | no |
| <a name="input_env"></a> [env](#input\_env) | Deployment environment name. Only "demo" exists today; later layers (events, simulator) will live under infra/live/demo/ alongside this root. | `string` | `"demo"` | no |
| <a name="input_household_id"></a> [household\_id](#input\_household\_id) | Household id seeded into the MCP server's environment as HOUSEHOLD\_ID. | `string` | `"hh_harlow"` | no |
| <a name="input_idle_session_timeout_seconds"></a> [idle\_session\_timeout\_seconds](#input\_idle\_session\_timeout\_seconds) | Idle runtime session timeout passed to the AgentCore runtime, in seconds. | `number` | `1800` | no |
| <a name="input_image_uri"></a> [image\_uri](#input\_image\_uri) | Full ECR image URI with tag, from scripts/build-image.sh. Empty on the first apply, which then creates only ECR, the table, Cognito, and the execution role. | `string` | `""` | no |
| <a name="input_region"></a> [region](#input\_region) | AWS region to deploy into. | `string` | `"us-east-1"` | no |

## Outputs

| Name | Description |
| ---- | ----------- |
| <a name="output_agent_runtime_arn"></a> [agent\_runtime\_arn](#output\_agent\_runtime\_arn) | ARN of the AgentCore runtime. Empty string until image\_uri is set on a later apply. |
| <a name="output_agent_runtime_invocation_url"></a> [agent\_runtime\_invocation\_url](#output\_agent\_runtime\_invocation\_url) | HTTPS invocation URL for the AgentCore runtime's DEFAULT endpoint. Empty string until image\_uri is set. |
| <a name="output_cognito_client_id"></a> [cognito\_client\_id](#output\_cognito\_client\_id) | Cognito app client id for the client-credentials flow. |
| <a name="output_cognito_client_secret"></a> [cognito\_client\_secret](#output\_cognito\_client\_secret) | Cognito app client secret. |
| <a name="output_cognito_client_secret_arn"></a> [cognito\_client\_secret\_arn](#output\_cognito\_client\_secret\_arn) | Secrets Manager ARN holding the Cognito client secret. |
| <a name="output_cognito_discovery_url"></a> [cognito\_discovery\_url](#output\_cognito\_discovery\_url) | OIDC discovery URL for the Cognito user pool used as the AgentCore JWT authorizer. |
| <a name="output_cognito_token_url"></a> [cognito\_token\_url](#output\_cognito\_token\_url) | OAuth2 client-credentials token endpoint. |
| <a name="output_ecr_repository_url"></a> [ecr\_repository\_url](#output\_ecr\_repository\_url) | URL of the ECR repository the MCP server image is pushed to. |
| <a name="output_table_name"></a> [table\_name](#output\_table\_name) | Name of the DynamoDB table backing the HomeLedger repository. |
<!-- END_TF_DOCS -->

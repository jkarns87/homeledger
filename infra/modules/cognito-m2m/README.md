# cognito-m2m

Creates a Cognito user pool configured for machine-to-machine
(`client_credentials`) OAuth: a hosted-UI domain, a resource server with one
scope, and an app client that authenticates with a client secret. The pool
serves as the JWT issuer AgentCore Runtime's custom JWT authorizer trusts.

The client secret is written into AWS Secrets Manager using the write-only
`secret_string_wo` / `secret_string_wo_version` arguments on
`aws_secretsmanager_secret_version`, so the secret value is not duplicated
into that resource's own state (it still appears in `aws_cognito_user_pool_client`
state, which the AWS Cognito API itself requires; there is no way to avoid
that side).

<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
| ---- | ------- |
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
| [aws_cognito_resource_server.this](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cognito_resource_server) | resource |
| [aws_cognito_user_pool.this](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cognito_user_pool) | resource |
| [aws_cognito_user_pool_client.this](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cognito_user_pool_client) | resource |
| [aws_cognito_user_pool_domain.this](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cognito_user_pool_domain) | resource |
| [aws_secretsmanager_secret.this](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/secretsmanager_secret) | resource |
| [aws_secretsmanager_secret_version.this](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/secretsmanager_secret_version) | resource |
| [aws_region.current](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/region) | data source |

## Inputs

| Name | Description | Type | Default | Required |
| ---- | ----------- | ---- | ------- | :------: |
| <a name="input_access_token_validity_minutes"></a> [access\_token\_validity\_minutes](#input\_access\_token\_validity\_minutes) | Access token validity, in minutes. | `number` | `60` | no |
| <a name="input_client_name"></a> [client\_name](#input\_client\_name) | Name for the client-credentials app client. | `string` | n/a | yes |
| <a name="input_domain_prefix"></a> [domain\_prefix](#input\_domain\_prefix) | Cognito Hosted UI domain prefix. Must be globally unique within the region. | `string` | n/a | yes |
| <a name="input_name"></a> [name](#input\_name) | Name for the Cognito user pool. | `string` | n/a | yes |
| <a name="input_resource_server_identifier"></a> [resource\_server\_identifier](#input\_resource\_server\_identifier) | Identifier for the Cognito resource server (the API's audience / scope namespace). | `string` | n/a | yes |
| <a name="input_scope_description"></a> [scope\_description](#input\_scope\_description) | Human-readable description of the OAuth scope. | `string` | n/a | yes |
| <a name="input_scope_name"></a> [scope\_name](#input\_scope\_name) | OAuth scope name registered on the resource server. | `string` | n/a | yes |
| <a name="input_secret_name"></a> [secret\_name](#input\_secret\_name) | Name for the Secrets Manager secret that holds the client secret. | `string` | n/a | yes |

## Outputs

| Name | Description |
| ---- | ----------- |
| <a name="output_client_id"></a> [client\_id](#output\_client\_id) | App client id for the client-credentials flow. |
| <a name="output_client_secret"></a> [client\_secret](#output\_client\_secret) | App client secret. |
| <a name="output_client_secret_arn"></a> [client\_secret\_arn](#output\_client\_secret\_arn) | Secrets Manager ARN holding the client secret. |
| <a name="output_discovery_url"></a> [discovery\_url](#output\_discovery\_url) | OIDC discovery URL for the user pool. |
| <a name="output_scope"></a> [scope](#output\_scope) | Full OAuth scope string ("identifier/scope\_name"). |
| <a name="output_token_url"></a> [token\_url](#output\_token\_url) | OAuth2 client-credentials token endpoint. |
| <a name="output_user_pool_id"></a> [user\_pool\_id](#output\_user\_pool\_id) | Cognito user pool id. |
<!-- END_TF_DOCS -->

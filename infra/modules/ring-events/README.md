# ring-events

Everything the Ring pipeline needs in AWS. It creates an HTTP API for the three URLs Ring calls (Token Exchange, Account Link, webhook), a custom EventBridge bus whose rules send raw Ring events to the visit correlator, sensor rules and device sync and send HomeLedger's own outcomes to push, and twelve Node 22 arm64 Lambda functions. Each function has its own least-privilege role, and each asynchronous function has a dead-letter queue that the DLQ alerter drains. The module also creates the EventBridge Scheduler schedules for the sensor poll, token refresh and nightly device sync, a WebSocket API whose `$connect` a Cognito client-credentials JWT authorises, a private snapshot bucket, and the `ring/tokens` secret container. Terraform never writes a value to that secret, so tokens never enter state.

`artifacts_dir` must hold the output of `pnpm --filter @homeledger/events build` (one `<handler>/index.mjs` per function) before any plan.

This module is never applied locally. Plan and apply run only in GitHub Actions. Locally the only commands are `terraform fmt`, `terraform init -backend=false`, `terraform validate` and `terraform test`, and the tests use mocked providers.

## Outputs

| Output | Value |
|---|---|
| `token_exchange_url` | `<http api endpoint>/ring/token` |
| `account_link_url` | `<http api endpoint>/ring/link` |
| `webhook_url` | `<http api endpoint>/ring/webhook` |
| `push_websocket_url` | the WebSocket stage's `wss://…/demo` invoke URL |
| `push_endpoint` | `https://<ws api id>.execute-api.<region>.amazonaws.com/demo` |
| `snapshot_bucket`, `snapshot_bucket_arn`, `snapshot_origin` | the bucket, its ARN, `https://<bucket>.s3.<region>.amazonaws.com` (the presigned host) |
| `event_bus_name`, `tokens_secret_arn` | |
| `secret_grants` | map function → list of secret ARNs it may read (for tests and the README) |

## Secrets (spec §3, as applied)

Each function gets `secretsmanager:GetSecretValue` on exactly the ARNs in its row and nothing else. The owner creates the four value secrets. This module creates only the `ring/tokens` container.

| Secret | Variable / source | Readers | Writers |
|---|---|---|---|
| `demo-homeledger/ring/client-secret` | `ring_client_secret_arn` | token-exchange, token-refresh | owner |
| `demo-homeledger/ring/hmac-key` | `ring_hmac_key_arn` | webhook, link | owner |
| `demo-homeledger/ring/tokens` | `aws_secretsmanager_secret.tokens` | token-exchange, link, device-sync, visit-correlator, sensor-poller, token-refresh | token-exchange, link, token-refresh |
| `demo-homeledger/anthropic/api-key` | `anthropic_key_arn` | visit-correlator | owner |
| `demo-homeledger/ring/link-passphrase` | `link_passphrase_arn` | link | owner |

sensor-rules, dlq-alerter, push, ws-authorizer and ws-connections read no secret. The Ring Client ID is not a secret. It is the `ring_client_id` variable.

<!-- BEGIN_TF_DOCS -->
## Requirements

| Name | Version |
| ---- | ------- |
| <a name="requirement_terraform"></a> [terraform](#requirement\_terraform) | >= 1.10.0 |
| <a name="requirement_archive"></a> [archive](#requirement\_archive) | >= 2.7.0, < 3.0.0 |
| <a name="requirement_aws"></a> [aws](#requirement\_aws) | >= 6.21.0, < 7.0.0 |

## Providers

| Name | Version |
| ---- | ------- |
| <a name="provider_archive"></a> [archive](#provider\_archive) | 2.8.1 |
| <a name="provider_aws"></a> [aws](#provider\_aws) | 6.66.0 |

## Modules

No modules.

## Resources

| Name | Type |
| ---- | ---- |
| [aws_apigatewayv2_api.http](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/apigatewayv2_api) | resource |
| [aws_apigatewayv2_api.ws](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/apigatewayv2_api) | resource |
| [aws_apigatewayv2_authorizer.ws](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/apigatewayv2_authorizer) | resource |
| [aws_apigatewayv2_integration.http](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/apigatewayv2_integration) | resource |
| [aws_apigatewayv2_integration.ws](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/apigatewayv2_integration) | resource |
| [aws_apigatewayv2_route.http](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/apigatewayv2_route) | resource |
| [aws_apigatewayv2_route.ws](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/apigatewayv2_route) | resource |
| [aws_apigatewayv2_stage.http](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/apigatewayv2_stage) | resource |
| [aws_apigatewayv2_stage.ws](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/apigatewayv2_stage) | resource |
| [aws_cloudwatch_event_bus.this](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudwatch_event_bus) | resource |
| [aws_cloudwatch_event_rule.this](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudwatch_event_rule) | resource |
| [aws_cloudwatch_event_target.this](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudwatch_event_target) | resource |
| [aws_cloudwatch_log_group.fn](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudwatch_log_group) | resource |
| [aws_iam_role.fn](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role) | resource |
| [aws_iam_role.scheduler](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role) | resource |
| [aws_iam_role_policy.fn](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role_policy) | resource |
| [aws_iam_role_policy.scheduler](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role_policy) | resource |
| [aws_lambda_event_source_mapping.dead_letters](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/lambda_event_source_mapping) | resource |
| [aws_lambda_function.fn](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/lambda_function) | resource |
| [aws_lambda_function.push](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/lambda_function) | resource |
| [aws_lambda_function_event_invoke_config.async](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/lambda_function_event_invoke_config) | resource |
| [aws_lambda_permission.events](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/lambda_permission) | resource |
| [aws_lambda_permission.http](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/lambda_permission) | resource |
| [aws_lambda_permission.ws](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/lambda_permission) | resource |
| [aws_s3_bucket.snapshots](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/s3_bucket) | resource |
| [aws_s3_bucket_policy.snapshots](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/s3_bucket_policy) | resource |
| [aws_s3_bucket_public_access_block.snapshots](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/s3_bucket_public_access_block) | resource |
| [aws_s3_bucket_server_side_encryption_configuration.snapshots](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/s3_bucket_server_side_encryption_configuration) | resource |
| [aws_s3_bucket_versioning.snapshots](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/s3_bucket_versioning) | resource |
| [aws_scheduler_schedule.this](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/scheduler_schedule) | resource |
| [aws_secretsmanager_secret.tokens](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/secretsmanager_secret) | resource |
| [aws_sqs_queue.dlq](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/sqs_queue) | resource |
| [aws_sqs_queue_policy.dlq](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/sqs_queue_policy) | resource |
| [archive_file.fn](https://registry.terraform.io/providers/hashicorp/archive/latest/docs/data-sources/file) | data source |
| [aws_caller_identity.current](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/caller_identity) | data source |
| [aws_region.current](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/region) | data source |

## Inputs

| Name | Description | Type | Default | Required |
| ---- | ----------- | ---- | ------- | :------: |
| <a name="input_anthropic_key_arn"></a> [anthropic\_key\_arn](#input\_anthropic\_key\_arn) | ARN of the owner-created secret holding the Anthropic API key used to describe snapshots. | `string` | n/a | yes |
| <a name="input_anthropic_model"></a> [anthropic\_model](#input\_anthropic\_model) | Model that describes a snapshot (spec §5). | `string` | `"claude-sonnet-5"` | no |
| <a name="input_artifacts_dir"></a> [artifacts\_dir](#input\_artifacts\_dir) | Directory holding apps/events' built bundles, one sub-directory per handler with an index.mjs. | `string` | n/a | yes |
| <a name="input_cognito_client_id"></a> [cognito\_client\_id](#input\_cognito\_client\_id) | App client whose tokens may open a push connection. | `string` | n/a | yes |
| <a name="input_cognito_user_pool_id"></a> [cognito\_user\_pool\_id](#input\_cognito\_user\_pool\_id) | User pool that issues the simulator's client-credentials token; the WebSocket authorizer verifies against it. | `string` | n/a | yes |
| <a name="input_household_id"></a> [household\_id](#input\_household\_id) | The one household the linked Ring account maps to (spec §3). | `string` | n/a | yes |
| <a name="input_link_passphrase_arn"></a> [link\_passphrase\_arn](#input\_link\_passphrase\_arn) | ARN of the owner-created secret holding the household passphrase the Account Link page asks for (R1). | `string` | n/a | yes |
| <a name="input_log_retention_days"></a> [log\_retention\_days](#input\_log\_retention\_days) | CloudWatch retention for every function's log group. | `number` | `14` | no |
| <a name="input_name_prefix"></a> [name\_prefix](#input\_name\_prefix) | Prefix for every resource name, e.g. demo-homeledger. | `string` | n/a | yes |
| <a name="input_ring_client_id"></a> [ring\_client\_id](#input\_ring\_client\_id) | Ring app Client ID. Not a secret (spec §3). Empty until the repository variable is set; the token-exchange and token-refresh functions fail loudly without it. | `string` | `""` | no |
| <a name="input_ring_client_secret_arn"></a> [ring\_client\_secret\_arn](#input\_ring\_client\_secret\_arn) | ARN of the owner-created secret holding the Ring client secret. | `string` | n/a | yes |
| <a name="input_ring_hmac_key_arn"></a> [ring\_hmac\_key\_arn](#input\_ring\_hmac\_key\_arn) | ARN of the owner-created secret holding the Ring HMAC signature key. | `string` | n/a | yes |
| <a name="input_secret_recovery_window_in_days"></a> [secret\_recovery\_window\_in\_days](#input\_secret\_recovery\_window\_in\_days) | Recovery window for the tokens secret this module creates. 0 deletes immediately (demo); otherwise 7-30. | `number` | `0` | no |
| <a name="input_sensor_appliance_id"></a> [sensor\_appliance\_id](#input\_sensor\_appliance\_id) | Appliance whose inspection a flood or freeze opens or advances (R12). | `string` | `"appl_waterheater22222"` | no |
| <a name="input_sensor_poll_minutes"></a> [sensor\_poll\_minutes](#input\_sensor\_poll\_minutes) | Minutes between reconciliation polls of sensor status (spec §6, default 2). | `number` | `2` | no |
| <a name="input_sensors_enabled"></a> [sensors\_enabled](#input\_sensors\_enabled) | Spec §6 flag: gates the live sensor path, independently of the doorbell path. | `bool` | `true` | no |
| <a name="input_snapshot_bucket_force_destroy"></a> [snapshot\_bucket\_force\_destroy](#input\_snapshot\_bucket\_force\_destroy) | Whether terraform destroy may delete a snapshot bucket that still holds images. | `bool` | `true` | no |
| <a name="input_table_arn"></a> [table\_arn](#input\_table\_arn) | HomeLedger DynamoDB table ARN. | `string` | n/a | yes |
| <a name="input_table_name"></a> [table\_name](#input\_table\_name) | HomeLedger DynamoDB table name. | `string` | n/a | yes |

## Outputs

| Name | Description |
| ---- | ----------- |
| <a name="output_account_link_url"></a> [account\_link\_url](#output\_account\_link\_url) | Ring Developer Portal: Account Link URL. |
| <a name="output_event_bus_name"></a> [event\_bus\_name](#output\_event\_bus\_name) | The custom event bus. |
| <a name="output_push_endpoint"></a> [push\_endpoint](#output\_push\_endpoint) | Management endpoint the push function posts through. |
| <a name="output_push_websocket_url"></a> [push\_websocket\_url](#output\_push\_websocket\_url) | WebSocket URL the simulator's server connects to (HOMELEDGER\_PUSH\_URL). |
| <a name="output_secret_grants"></a> [secret\_grants](#output\_secret\_grants) | Per function, the secret ARNs it may read - spec §3's table, as applied. |
| <a name="output_snapshot_bucket"></a> [snapshot\_bucket](#output\_snapshot\_bucket) | Bucket holding doorbell snapshots under snapshots/. |
| <a name="output_snapshot_bucket_arn"></a> [snapshot\_bucket\_arn](#output\_snapshot\_bucket\_arn) | ARN of the snapshot bucket; the MCP runtime may read snapshots/* only. |
| <a name="output_snapshot_origin"></a> [snapshot\_origin](#output\_snapshot\_origin) | Origin of presigned snapshot URLs; the visit widget declares it as a resource domain (R8). Built from the bucket name and region, the virtual-hosted host the SDK presigns against, so it does not depend on a provider attribute's format. |
| <a name="output_token_exchange_url"></a> [token\_exchange\_url](#output\_token\_exchange\_url) | Ring Developer Portal: Token Exchange URL. |
| <a name="output_tokens_secret_arn"></a> [tokens\_secret\_arn](#output\_tokens\_secret\_arn) | Secret the token-exchange, link and token-refresh functions write the Ring tokens to. |
| <a name="output_webhook_url"></a> [webhook\_url](#output\_webhook\_url) | Ring Developer Portal: Webhook URL. |
<!-- END_TF_DOCS -->

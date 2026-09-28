# Native tests with mocked providers: no AWS call, no built bundles needed
# (archive_file is mocked too). Every ARN-typed attribute that another
# resource consumes is pinned, because the AWS provider validates ARN shape on
# arguments and a mock's random string is not an ARN.
mock_provider "archive" {}

mock_provider "aws" {
  override_data {
    target = data.aws_caller_identity.current
    values = { account_id = "123456789012" }
  }
  override_data {
    target = data.aws_region.current
    values = { region = "us-east-1" }
  }
  override_resource {
    target = aws_iam_role.fn
    values = { arn = "arn:aws:iam::123456789012:role/demo-homeledger-fn" }
  }
  override_resource {
    target = aws_iam_role.scheduler
    values = { arn = "arn:aws:iam::123456789012:role/demo-homeledger-ring-scheduler" }
  }
  override_resource {
    target = aws_sqs_queue.dlq
    values = { arn = "arn:aws:sqs:us-east-1:123456789012:dlq", id = "https://sqs.us-east-1.amazonaws.com/123456789012/dlq" }
  }
  override_resource {
    target = aws_cloudwatch_log_group.fn
    values = { arn = "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/fn" }
  }
  override_resource {
    target = aws_cloudwatch_event_bus.this
    values = { arn = "arn:aws:events:us-east-1:123456789012:event-bus/demo-homeledger" }
  }
  override_resource {
    target = aws_cloudwatch_event_rule.this
    values = { arn = "arn:aws:events:us-east-1:123456789012:rule/demo-homeledger/rule" }
  }
  override_resource {
    target = aws_lambda_function.fn
    values = { arn = "arn:aws:lambda:us-east-1:123456789012:function:fn", invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:fn/invocations" }
  }
  override_resource {
    target = aws_lambda_function.push
    values = { arn = "arn:aws:lambda:us-east-1:123456789012:function:push", invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:push/invocations" }
  }
  override_resource {
    target = aws_apigatewayv2_api.http
    values = { id = "httpapi01", api_endpoint = "https://httpapi01.execute-api.us-east-1.amazonaws.com", execution_arn = "arn:aws:execute-api:us-east-1:123456789012:httpapi01" }
  }
  override_resource {
    target = aws_apigatewayv2_api.ws
    values = { id = "wsapi01", execution_arn = "arn:aws:execute-api:us-east-1:123456789012:wsapi01" }
  }
  override_resource {
    target = aws_apigatewayv2_stage.ws
    values = { invoke_url = "wss://wsapi01.execute-api.us-east-1.amazonaws.com/demo" }
  }
  override_resource {
    target = aws_s3_bucket.snapshots
    values = { arn = "arn:aws:s3:::demo-homeledger-snapshots-123456789012", bucket = "demo-homeledger-snapshots-123456789012", bucket_regional_domain_name = "demo-homeledger-snapshots-123456789012.s3.us-east-1.amazonaws.com" }
  }
  override_resource {
    target = aws_secretsmanager_secret.tokens
    values = { arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:demo-homeledger/ring/tokens-AbCdEf" }
  }
}

variables {
  name_prefix            = "demo-homeledger"
  household_id           = "hh_harlow"
  table_name             = "demo-homeledger"
  table_arn              = "arn:aws:dynamodb:us-east-1:123456789012:table/demo-homeledger"
  artifacts_dir          = "../../../apps/events/dist"
  ring_client_id         = "client-1"
  ring_client_secret_arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:demo-homeledger/ring/client-secret-l29t29"
  ring_hmac_key_arn      = "arn:aws:secretsmanager:us-east-1:123456789012:secret:demo-homeledger/ring/hmac-key-k7NhwE"
  anthropic_key_arn      = "arn:aws:secretsmanager:us-east-1:123456789012:secret:demo-homeledger/anthropic/api-key-Zz0000"
  link_passphrase_arn    = "arn:aws:secretsmanager:us-east-1:123456789012:secret:demo-homeledger/ring/link-passphrase-Yy0000"
  cognito_user_pool_id   = "us-east-1_Example1"
  cognito_client_id      = "cognito-client-1"
}

run "every_handler_is_a_node22_arm64_function" {
  command = apply
  assert {
    condition     = length(aws_lambda_function.fn) == 11 && alltrue([for f in values(aws_lambda_function.fn) : f.runtime == "nodejs22.x" && f.architectures[0] == "arm64" && f.handler == "index.handler"])
    error_message = "eleven for_each functions plus push, all nodejs22.x on arm64 with index.handler"
  }
  assert {
    condition     = aws_lambda_function.push.runtime == "nodejs22.x" && aws_lambda_function.push.environment[0].variables.PUSH_ENDPOINT == "https://wsapi01.execute-api.us-east-1.amazonaws.com/demo"
    error_message = "push posts through the WebSocket management endpoint"
  }
}

run "secrets_are_granted_exactly_as_spec_section_3_says" {
  command = apply
  assert {
    condition     = output.secret_grants["webhook"] == [var.ring_hmac_key_arn]
    error_message = "the webhook reads the HMAC key and nothing else"
  }
  assert {
    condition     = output.secret_grants["visit-correlator"] == ["arn:aws:secretsmanager:us-east-1:123456789012:secret:demo-homeledger/ring/tokens-AbCdEf", var.anthropic_key_arn]
    error_message = "the correlator reads the tokens and the Anthropic key"
  }
  assert {
    condition     = output.secret_grants["link"] == [var.ring_hmac_key_arn, var.link_passphrase_arn, "arn:aws:secretsmanager:us-east-1:123456789012:secret:demo-homeledger/ring/tokens-AbCdEf"]
    error_message = "the link reads the HMAC key, the passphrase and the tokens"
  }
  assert {
    condition     = output.secret_grants["ws-authorizer"] == [] && output.secret_grants["push"] == [] && output.secret_grants["sensor-rules"] == []
    error_message = "functions outside the table read no secret"
  }
  assert {
    condition     = one([for s in jsondecode(aws_iam_role_policy.fn["webhook"].policy).Statement : s.Resource if s.Sid == "ReadSecrets"]) == [var.ring_hmac_key_arn]
    error_message = "the webhook role's policy must carry the same single grant"
  }
}

run "only_the_correlator_writes_snapshots_and_only_under_snapshots" {
  command = apply
  assert {
    condition     = one([for s in jsondecode(aws_iam_role_policy.fn["visit-correlator"].policy).Statement : s.Resource if s.Sid == "WriteSnapshots"]) == ["arn:aws:s3:::demo-homeledger-snapshots-123456789012/snapshots/*"]
    error_message = "the correlator may put objects under snapshots/ only"
  }
  assert {
    condition     = alltrue([for k, p in aws_iam_role_policy.fn : k == "visit-correlator" || length([for s in jsondecode(p.policy).Statement : s if s.Sid == "WriteSnapshots"]) == 0])
    error_message = "no other function may write snapshots"
  }
}

run "ring_routes_are_exactly_the_three_urls" {
  command = plan
  assert {
    condition     = toset(keys(aws_apigatewayv2_route.http)) == toset(["POST /ring/token", "GET /ring/link", "POST /ring/link", "POST /ring/webhook"])
    error_message = "token exchange, account link (GET and POST) and webhook"
  }
}

run "connect_is_authorised_by_the_authorization_header" {
  command = apply
  assert {
    condition     = aws_apigatewayv2_route.ws["$connect"].authorization_type == "CUSTOM" && aws_apigatewayv2_route.ws["$default"].authorization_type == "NONE"
    error_message = "$connect is authorised; the keepalive route is not"
  }
  assert {
    condition     = toset(aws_apigatewayv2_authorizer.ws.identity_sources) == toset(["route.request.header.Authorization"])
    error_message = "the token must come from the Authorization header, never the query string"
  }
}

run "the_doorbell_rule_routes_presses_and_human_motion_only" {
  command = plan
  assert {
    condition = jsondecode(aws_cloudwatch_event_rule.this["doorbell"].event_pattern) == {
      source = ["ring.webhook"]
      "$or"  = [{ "detail-type" = ["button_press"] }, { "detail-type" = ["motion_detected"], detail = { subType = ["human"] } }]
    }
    error_message = "doorbell rule pattern"
  }
  assert {
    condition     = jsondecode(aws_cloudwatch_event_rule.this["push"].event_pattern).source == ["homeledger.events"]
    error_message = "push listens only to HomeLedger's own outcomes"
  }
}

run "every_async_function_has_a_dead_letter_queue_and_two_retries" {
  command = apply
  assert {
    condition     = toset(keys(aws_sqs_queue.dlq)) == toset(["device-sync", "visit-correlator", "sensor-rules", "sensor-poller", "token-refresh", "push"])
    error_message = "six dead-letter queues"
  }
  assert {
    condition     = alltrue([for c in values(aws_lambda_function_event_invoke_config.async) : c.maximum_retry_attempts == 2])
    error_message = "two retries before dead-lettering"
  }
  assert {
    condition     = length(aws_lambda_event_source_mapping.dead_letters) == 6
    error_message = "the alerter reads every dead-letter queue"
  }
}

run "the_poll_interval_is_configurable_and_the_flag_pauses_it" {
  command = plan
  variables {
    sensor_poll_minutes = 1
    sensors_enabled     = false
  }
  assert {
    condition     = aws_scheduler_schedule.this["sensor-poll"].schedule_expression == "rate(1 minute)" && aws_scheduler_schedule.this["sensor-poll"].state == "DISABLED"
    error_message = "one minute is singular, and the sensor flag disables the poll"
  }
  assert {
    condition     = aws_lambda_function.fn["sensor-rules"].environment[0].variables.SENSORS_ENABLED == "0"
    error_message = "the flag reaches the rules function too"
  }
}

run "the_default_poll_is_every_two_minutes" {
  command = plan
  assert {
    condition     = aws_scheduler_schedule.this["sensor-poll"].schedule_expression == "rate(2 minutes)" && aws_scheduler_schedule.this["sensor-poll"].state == "ENABLED"
    error_message = "spec §6 default"
  }
}

run "rejects_a_fractional_or_zero_poll_interval" {
  command = plan
  variables {
    sensor_poll_minutes = 0
  }
  expect_failures = [var.sensor_poll_minutes]
}

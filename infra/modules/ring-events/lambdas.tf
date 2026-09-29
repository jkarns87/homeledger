locals {
  # One row per handler in apps/events/src/handlers. `table`, `bus`, `snapshots`
  # and the two secret lists are what the role may do; `async` functions get a
  # dead-letter queue and two retries. Spec §3 fixes the secret columns.
  functions = {
    "webhook"          = { timeout = 10, memory = 256, table = true, bus = true, snapshots = false, async = false, secrets_read = ["hmac"], secrets_write = [] }
    "token-exchange"   = { timeout = 30, memory = 256, table = false, bus = false, snapshots = false, async = false, secrets_read = ["client_secret", "tokens"], secrets_write = ["tokens"] }
    "link"             = { timeout = 30, memory = 256, table = true, bus = false, snapshots = false, async = false, secrets_read = ["hmac", "passphrase", "tokens"], secrets_write = ["tokens"] }
    "device-sync"      = { timeout = 60, memory = 256, table = true, bus = true, snapshots = false, async = true, secrets_read = ["tokens"], secrets_write = [] }
    "visit-correlator" = { timeout = 120, memory = 512, table = true, bus = true, snapshots = true, async = true, secrets_read = ["tokens", "anthropic"], secrets_write = [] }
    "sensor-rules"     = { timeout = 30, memory = 256, table = true, bus = true, snapshots = false, async = true, secrets_read = [], secrets_write = [] }
    "sensor-poller"    = { timeout = 60, memory = 256, table = true, bus = true, snapshots = false, async = true, secrets_read = ["tokens"], secrets_write = [] }
    "token-refresh"    = { timeout = 30, memory = 256, table = true, bus = true, snapshots = false, async = true, secrets_read = ["client_secret", "tokens"], secrets_write = ["tokens"] }
    "dlq-alerter"      = { timeout = 30, memory = 256, table = true, bus = false, snapshots = false, async = false, secrets_read = [], secrets_write = [] }
    "push"             = { timeout = 30, memory = 256, table = true, bus = false, snapshots = false, async = true, secrets_read = [], secrets_write = [] }
    "ws-authorizer"    = { timeout = 10, memory = 256, table = false, bus = false, snapshots = false, async = false, secrets_read = [], secrets_write = [] }
    "ws-connections"   = { timeout = 10, memory = 256, table = true, bus = false, snapshots = false, async = false, secrets_read = [], secrets_write = [] }
  }
  async_functions = { for k, f in local.functions : k => f if f.async }

  common_env = { TABLE_NAME = var.table_name, HOUSEHOLD_ID = var.household_id }

  # The environment contract (Plan 4 Task 8). push's is set on its own resource.
  function_env = {
    "webhook"          = { EVENT_BUS_NAME = aws_cloudwatch_event_bus.this.name, RING_HMAC_SECRET_ID = local.secret_arns.hmac }
    "token-exchange"   = { RING_CLIENT_ID = var.ring_client_id, RING_CLIENT_SECRET_ID = local.secret_arns.client_secret, RING_TOKENS_SECRET_ID = local.secret_arns.tokens }
    "link"             = { RING_HMAC_SECRET_ID = local.secret_arns.hmac, RING_LINK_PASSPHRASE_SECRET_ID = local.secret_arns.passphrase, RING_TOKENS_SECRET_ID = local.secret_arns.tokens }
    "device-sync"      = { EVENT_BUS_NAME = aws_cloudwatch_event_bus.this.name, RING_TOKENS_SECRET_ID = local.secret_arns.tokens }
    "visit-correlator" = { EVENT_BUS_NAME = aws_cloudwatch_event_bus.this.name, RING_TOKENS_SECRET_ID = local.secret_arns.tokens, ANTHROPIC_KEY_SECRET_ID = local.secret_arns.anthropic, ANTHROPIC_MODEL = var.anthropic_model, SNAPSHOT_BUCKET = aws_s3_bucket.snapshots.bucket }
    "sensor-rules"     = { EVENT_BUS_NAME = aws_cloudwatch_event_bus.this.name, SENSORS_ENABLED = var.sensors_enabled ? "1" : "0", SENSOR_APPLIANCE_ID = var.sensor_appliance_id }
    "sensor-poller"    = { EVENT_BUS_NAME = aws_cloudwatch_event_bus.this.name, SENSORS_ENABLED = var.sensors_enabled ? "1" : "0", SENSOR_APPLIANCE_ID = var.sensor_appliance_id, RING_TOKENS_SECRET_ID = local.secret_arns.tokens }
    "token-refresh"    = { EVENT_BUS_NAME = aws_cloudwatch_event_bus.this.name, RING_CLIENT_ID = var.ring_client_id, RING_CLIENT_SECRET_ID = local.secret_arns.client_secret, RING_TOKENS_SECRET_ID = local.secret_arns.tokens }
    "dlq-alerter"      = {}
    "ws-authorizer"    = { COGNITO_USER_POOL_ID = var.cognito_user_pool_id, COGNITO_CLIENT_ID = var.cognito_client_id }
    "ws-connections"   = {}
  }

  statements = {
    for k, f in local.functions : k => concat(
      [{ Sid = "Logs", Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = ["${aws_cloudwatch_log_group.fn[k].arn}:*"] }],
      f.table ? [{ Sid = "Table", Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query"], Resource = [var.table_arn, "${var.table_arn}/index/*"] }] : [],
      length(f.secrets_read) > 0 ? [{ Sid = "ReadSecrets", Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = [for s in f.secrets_read : local.secret_arns[s]] }] : [],
      length(f.secrets_write) > 0 ? [{ Sid = "WriteSecrets", Effect = "Allow", Action = ["secretsmanager:PutSecretValue"], Resource = [for s in f.secrets_write : local.secret_arns[s]] }] : [],
      f.bus ? [{ Sid = "PutEvents", Effect = "Allow", Action = ["events:PutEvents"], Resource = [aws_cloudwatch_event_bus.this.arn] }] : [],
      f.snapshots ? [{ Sid = "WriteSnapshots", Effect = "Allow", Action = ["s3:PutObject"], Resource = ["${aws_s3_bucket.snapshots.arn}/snapshots/*"] }] : [],
      f.async ? [{ Sid = "DeadLetter", Effect = "Allow", Action = ["sqs:SendMessage"], Resource = [aws_sqs_queue.dlq[k].arn] }] : [],
      k == "push" ? [{ Sid = "ManageConnections", Effect = "Allow", Action = ["execute-api:ManageConnections"], Resource = ["${aws_apigatewayv2_api.ws.execution_arn}/${local.ws_stage}/POST/@connections/*"] }] : [],
      k == "dlq-alerter" ? [{ Sid = "ReadDeadLetters", Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"], Resource = [for q in aws_sqs_queue.dlq : q.arn] }] : []
    )
  }
}

data "archive_file" "fn" {
  for_each    = local.functions
  type        = "zip"
  source_dir  = "${var.artifacts_dir}/${each.key}"
  output_path = "${path.module}/.build/${each.key}.zip"
}

resource "aws_cloudwatch_log_group" "fn" {
  for_each          = local.functions
  name              = "/aws/lambda/${var.name_prefix}-${each.key}"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "fn" {
  for_each = local.functions
  name     = "${var.name_prefix}-${each.key}"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "fn" {
  for_each = local.functions
  role     = aws_iam_role.fn[each.key].id
  policy   = jsonencode({ Version = "2012-10-17", Statement = local.statements[each.key] })
}

# trivy:ignore:AVD-AWS-0135 SQS-managed SSE encrypts at rest; a CMK would add a key policy for no change in who can read a dead letter.
resource "aws_sqs_queue" "dlq" {
  for_each                   = local.async_functions
  name                       = "${var.name_prefix}-${each.key}-dead-letters"
  message_retention_seconds  = 1209600
  visibility_timeout_seconds = 180 # at least six times the dlq-alerter's 30 s timeout
  sqs_managed_sse_enabled    = true
}

resource "aws_lambda_function" "fn" {
  for_each         = { for k, f in local.functions : k => f if k != "push" }
  function_name    = "${var.name_prefix}-${each.key}"
  role             = aws_iam_role.fn[each.key].arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.fn[each.key].output_path
  source_code_hash = data.archive_file.fn[each.key].output_base64sha256
  timeout          = each.value.timeout
  memory_size      = each.value.memory

  environment {
    variables = merge(local.common_env, local.function_env[each.key])
  }

  dynamic "dead_letter_config" {
    for_each = each.value.async ? [aws_sqs_queue.dlq[each.key].arn] : []
    content {
      target_arn = dead_letter_config.value
    }
  }

  depends_on = [aws_cloudwatch_log_group.fn, aws_iam_role_policy.fn]
}

# Separate from the for_each above: its environment names the WebSocket API,
# whose integration names ws-connections - one block would be a cycle.
resource "aws_lambda_function" "push" {
  function_name    = "${var.name_prefix}-push"
  role             = aws_iam_role.fn["push"].arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.fn["push"].output_path
  source_code_hash = data.archive_file.fn["push"].output_base64sha256
  timeout          = local.functions["push"].timeout
  memory_size      = local.functions["push"].memory

  environment {
    variables = merge(local.common_env, { PUSH_ENDPOINT = local.push_endpoint })
  }

  dead_letter_config {
    target_arn = aws_sqs_queue.dlq["push"].arn
  }

  depends_on = [aws_cloudwatch_log_group.fn, aws_iam_role_policy.fn]
}

locals {
  function_arns = merge({ for k, f in aws_lambda_function.fn : k => f.arn }, { push = aws_lambda_function.push.arn })
}

resource "aws_lambda_function_event_invoke_config" "async" {
  for_each                     = local.async_functions
  function_name                = each.key == "push" ? aws_lambda_function.push.function_name : aws_lambda_function.fn[each.key].function_name
  maximum_retry_attempts       = 2
  maximum_event_age_in_seconds = 3600
}

resource "aws_lambda_event_source_mapping" "dead_letters" {
  for_each         = aws_sqs_queue.dlq
  event_source_arn = each.value.arn
  function_name    = aws_lambda_function.fn["dlq-alerter"].arn
  batch_size       = 10
}

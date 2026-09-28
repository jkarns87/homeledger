# Rules on the bus: raw Ring events (source ring.webhook) fan out to the three
# consumers; HomeLedger's own outcomes (source homeledger.events) go to push.
locals {
  rules = {
    "doorbell" = {
      function = "visit-correlator"
      pattern = {
        source = ["ring.webhook"]
        "$or" = [
          { "detail-type" = ["button_press"] },
          { "detail-type" = ["motion_detected"], detail = { subType = ["human"] } }
        ]
      }
    }
    "sensors" = {
      function = "sensor-rules"
      pattern  = { source = ["ring.webhook"], "detail-type" = ["flood_detected", "flood_cleared", "freeze_detected", "freeze_cleared", "contact_sensor_faulted", "contact_sensor_cleared"] }
    }
    "devices" = {
      function = "device-sync"
      pattern  = { source = ["ring.webhook"], "detail-type" = ["device_added", "device_removed", "device_online", "device_offline", "app_integration_added", "app_integration_removed"] }
    }
    "push" = {
      function = "push"
      pattern  = { source = ["homeledger.events"], "detail-type" = ["visit.arrived", "alert.raised"] }
    }
  }
}

resource "aws_cloudwatch_event_rule" "this" {
  for_each       = local.rules
  name           = "${var.name_prefix}-${each.key}"
  event_bus_name = aws_cloudwatch_event_bus.this.name
  event_pattern  = jsonencode(each.value.pattern)
}

resource "aws_cloudwatch_event_target" "this" {
  for_each       = local.rules
  rule           = aws_cloudwatch_event_rule.this[each.key].name
  event_bus_name = aws_cloudwatch_event_bus.this.name
  arn            = local.function_arns[each.value.function]
  retry_policy {
    maximum_retry_attempts       = 2
    maximum_event_age_in_seconds = 3600
  }
  dead_letter_config {
    arn = aws_sqs_queue.dlq[each.value.function].arn
  }
}

resource "aws_lambda_permission" "events" {
  for_each      = local.rules
  statement_id  = "AllowBusRule-${each.key}"
  action        = "lambda:InvokeFunction"
  function_name = local.function_arns[each.value.function]
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.this[each.key].arn
}

# EventBridge delivers to a target's DLQ under a queue policy, not a role.
resource "aws_sqs_queue_policy" "dlq" {
  for_each  = local.rules
  queue_url = aws_sqs_queue.dlq[each.value.function].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.dlq[each.value.function].arn
      Condition = { ArnEquals = { "aws:SourceArn" = aws_cloudwatch_event_rule.this[each.key].arn } }
    }]
  })
}

# ---------- Schedules: the reconciliation poll, the token refresh, the nightly device sync ----------
locals {
  schedules = {
    "sensor-poll"   = { function = "sensor-poller", expression = var.sensor_poll_minutes == 1 ? "rate(1 minute)" : "rate(${var.sensor_poll_minutes} minutes)", state = var.sensors_enabled ? "ENABLED" : "DISABLED", detail_type = "sensor-poll" }
    "token-refresh" = { function = "token-refresh", expression = "rate(30 minutes)", state = "ENABLED", detail_type = "token-refresh" }
    "device-sync"   = { function = "device-sync", expression = "cron(0 3 * * ? *)", state = "ENABLED", detail_type = "Scheduled Event" }
  }
}

resource "aws_iam_role" "scheduler" {
  name = "${var.name_prefix}-ring-scheduler"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "scheduler.amazonaws.com" }, Action = "sts:AssumeRole", Condition = { StringEquals = { "aws:SourceAccount" = local.account_id } } }]
  })
}

resource "aws_iam_role_policy" "scheduler" {
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "Invoke", Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = [for s in local.schedules : local.function_arns[s.function]] },
      { Sid = "DeadLetter", Effect = "Allow", Action = ["sqs:SendMessage"], Resource = [for s in local.schedules : aws_sqs_queue.dlq[s.function].arn] }
    ]
  })
}

resource "aws_scheduler_schedule" "this" {
  for_each                     = local.schedules
  name                         = "${var.name_prefix}-${each.key}"
  schedule_expression          = each.value.expression
  schedule_expression_timezone = "America/Chicago"
  state                        = each.value.state
  flexible_time_window {
    mode = "OFF"
  }
  target {
    arn      = local.function_arns[each.value.function]
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ "detail-type" = each.value.detail_type, source = "homeledger.schedule", detail = {} })
    retry_policy {
      maximum_retry_attempts = 0
    }
    dead_letter_config {
      arn = aws_sqs_queue.dlq[each.value.function].arn
    }
  }
}

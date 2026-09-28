# Ring -> HomeLedger: the Token Exchange URL, the Account Link URL, the webhook (amendment §12.1–12.3).
resource "aws_apigatewayv2_api" "http" {
  name          = "${var.name_prefix}-ring"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_stage" "http" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true
  default_route_settings {
    throttling_burst_limit = 20
    throttling_rate_limit  = 10
  }
}

locals {
  http_routes = {
    "POST /ring/token"   = "token-exchange"
    "GET /ring/link"     = "link"
    "POST /ring/link"    = "link"
    "POST /ring/webhook" = "webhook"
  }
  http_functions = toset(values(local.http_routes))
}

resource "aws_apigatewayv2_integration" "http" {
  for_each               = local.http_functions
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_method     = "POST"
  integration_uri        = aws_lambda_function.fn[each.key].invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "http" {
  for_each  = local.http_routes
  api_id    = aws_apigatewayv2_api.http.id
  route_key = each.key
  target    = "integrations/${aws_apigatewayv2_integration.http[each.value].id}"
}

resource "aws_lambda_permission" "http" {
  for_each      = local.http_functions
  statement_id  = "AllowRingHttpApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fn[each.key].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}

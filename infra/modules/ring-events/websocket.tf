# HomeLedger -> the simulator's server (spec §7). $connect is authorised by the
# Cognito client-credentials JWT, carried in the Authorization header.
resource "aws_apigatewayv2_api" "ws" {
  name                       = "${var.name_prefix}-push"
  protocol_type              = "WEBSOCKET"
  route_selection_expression = "$request.body.action"
}

resource "aws_apigatewayv2_authorizer" "ws" {
  api_id           = aws_apigatewayv2_api.ws.id
  name             = "${var.name_prefix}-push-jwt"
  authorizer_type  = "REQUEST"
  authorizer_uri   = aws_lambda_function.fn["ws-authorizer"].invoke_arn
  identity_sources = ["route.request.header.Authorization"]
}

resource "aws_apigatewayv2_integration" "ws" {
  api_id             = aws_apigatewayv2_api.ws.id
  integration_type   = "AWS_PROXY"
  integration_method = "POST"
  integration_uri    = aws_lambda_function.fn["ws-connections"].invoke_arn
}

resource "aws_apigatewayv2_route" "ws" {
  for_each           = toset(["$connect", "$disconnect", "$default"])
  api_id             = aws_apigatewayv2_api.ws.id
  route_key          = each.key
  target             = "integrations/${aws_apigatewayv2_integration.ws.id}"
  authorization_type = each.key == "$connect" ? "CUSTOM" : "NONE"
  authorizer_id      = each.key == "$connect" ? aws_apigatewayv2_authorizer.ws.id : null
}

resource "aws_apigatewayv2_stage" "ws" {
  api_id      = aws_apigatewayv2_api.ws.id
  name        = local.ws_stage
  auto_deploy = true
}

resource "aws_lambda_permission" "ws" {
  for_each      = toset(["ws-authorizer", "ws-connections"])
  statement_id  = "AllowPushWebSocketApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fn[each.key].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.ws.execution_arn}/*"
}

locals {
  push_endpoint = "https://${aws_apigatewayv2_api.ws.id}.execute-api.${local.region}.amazonaws.com/${local.ws_stage}"
}

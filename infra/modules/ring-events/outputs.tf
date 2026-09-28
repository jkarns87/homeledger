output "token_exchange_url" {
  description = "Ring Developer Portal: Token Exchange URL."
  value       = "${aws_apigatewayv2_api.http.api_endpoint}/ring/token"
}

output "account_link_url" {
  description = "Ring Developer Portal: Account Link URL."
  value       = "${aws_apigatewayv2_api.http.api_endpoint}/ring/link"
}

output "webhook_url" {
  description = "Ring Developer Portal: Webhook URL."
  value       = "${aws_apigatewayv2_api.http.api_endpoint}/ring/webhook"
}

output "push_websocket_url" {
  description = "WebSocket URL the simulator's server connects to (HOMELEDGER_PUSH_URL)."
  value       = aws_apigatewayv2_stage.ws.invoke_url
}

output "push_endpoint" {
  description = "Management endpoint the push function posts through."
  value       = local.push_endpoint
}

output "snapshot_bucket" {
  description = "Bucket holding doorbell snapshots under snapshots/."
  value       = aws_s3_bucket.snapshots.bucket
}

output "snapshot_bucket_arn" {
  description = "ARN of the snapshot bucket; the MCP runtime may read snapshots/* only."
  value       = aws_s3_bucket.snapshots.arn
}

output "snapshot_origin" {
  description = "Origin of presigned snapshot URLs; the visit widget declares it as a resource domain (R8)."
  value       = "https://${aws_s3_bucket.snapshots.bucket_regional_domain_name}"
}

output "event_bus_name" {
  description = "The custom event bus."
  value       = aws_cloudwatch_event_bus.this.name
}

output "tokens_secret_arn" {
  description = "Secret the link and token-refresh functions write the Ring tokens to."
  value       = aws_secretsmanager_secret.tokens.arn
}

output "secret_grants" {
  description = "Per function, the secret ARNs it may read - spec §3's table, as applied."
  value       = { for k, f in local.functions : k => [for s in f.secrets_read : local.secret_arns[s]] }
}

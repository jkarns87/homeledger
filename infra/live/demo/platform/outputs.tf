output "ecr_repository_url" {
  description = "URL of the ECR repository the MCP server image is pushed to."
  value       = aws_ecr_repository.mcp.repository_url
}

output "table_name" {
  description = "Name of the DynamoDB table backing the HomeLedger repository."
  value       = aws_dynamodb_table.homeledger.name
}

output "cognito_discovery_url" {
  description = "OIDC discovery URL for the Cognito user pool used as the AgentCore JWT authorizer."
  value       = module.cognito.discovery_url
}

output "cognito_token_url" {
  description = "OAuth2 client-credentials token endpoint."
  value       = module.cognito.token_url
}

output "cognito_client_id" {
  description = "Cognito app client id for the client-credentials flow."
  value       = module.cognito.client_id
}

output "cognito_client_secret" {
  description = "Cognito app client secret."
  value       = module.cognito.client_secret
  sensitive   = true
}

output "cognito_client_secret_arn" {
  description = "Secrets Manager ARN holding the Cognito client secret."
  value       = module.cognito.client_secret_arn
}

output "agent_runtime_arn" {
  description = "ARN of the AgentCore runtime. Empty string until image_uri is set on a later apply."
  value       = module.agentcore_runtime.agent_runtime_arn
}

output "agent_runtime_invocation_url" {
  description = "HTTPS invocation URL for the AgentCore runtime's DEFAULT endpoint. Empty string until image_uri is set."
  value       = module.agentcore_runtime.invocation_url
}

output "deployed_image_uri" {
  description = "Image URI the runtime was last applied with; the PR plan job passes it back so plans never show a runtime destroy."
  value       = var.image_uri
}

output "manuals_bucket" {
  description = "S3 bucket holding manual PDFs and their metadata sidecars."
  value       = module.knowledge_base.manuals_bucket
}

output "manuals_prefix" {
  description = "Key prefix inside the manuals bucket that the knowledge base ingests."
  value       = module.knowledge_base.manuals_prefix
}

output "knowledge_base_id" {
  description = "Bedrock Knowledge Base id used by ask_manual and by the manuals ingestion script."
  value       = module.knowledge_base.knowledge_base_id
}

output "data_source_id" {
  description = "Bedrock data source id used by the manuals ingestion script to start ingestion jobs."
  value       = module.knowledge_base.data_source_id
}

output "ring_token_exchange_url" {
  description = "Ring Developer Portal: Token Exchange URL."
  value       = module.ring_events.token_exchange_url
}

output "ring_account_link_url" {
  description = "Ring Developer Portal: Account Link URL."
  value       = module.ring_events.account_link_url
}

output "ring_webhook_url" {
  description = "Ring Developer Portal: Webhook URL."
  value       = module.ring_events.webhook_url
}

output "push_websocket_url" {
  description = "HOMELEDGER_PUSH_URL for the simulator."
  value       = module.ring_events.push_websocket_url
}

output "snapshot_bucket" {
  description = "Doorbell snapshot bucket."
  value       = module.ring_events.snapshot_bucket
}

output "ring_event_bus_name" {
  description = "The Ring pipeline's event bus."
  value       = module.ring_events.event_bus_name
}

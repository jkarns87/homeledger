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

output "user_pool_id" {
  description = "Cognito user pool id."
  value       = aws_cognito_user_pool.this.id
}

output "discovery_url" {
  description = "OIDC discovery URL for the user pool."
  value       = "https://cognito-idp.${local.region}.amazonaws.com/${aws_cognito_user_pool.this.id}/.well-known/openid-configuration"
}

output "token_url" {
  description = "OAuth2 client-credentials token endpoint."
  value       = "https://${aws_cognito_user_pool_domain.this.domain}.auth.${local.region}.amazoncognito.com/oauth2/token"
}

output "client_id" {
  description = "App client id for the client-credentials flow."
  value       = aws_cognito_user_pool_client.this.id
}

output "client_secret" {
  description = "App client secret."
  value       = aws_cognito_user_pool_client.this.client_secret
  sensitive   = true
}

output "client_secret_arn" {
  description = "Secrets Manager ARN holding the client secret."
  value       = aws_secretsmanager_secret.this.arn
}

output "scope" {
  description = "Full OAuth scope string (\"identifier/scope_name\")."
  value       = local.scope
}

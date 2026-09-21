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

# Exposed so a calling root can assert which deletion semantics it actually
# got. Terraform test assertions can read a module's outputs but not its
# resources, so without this there is no way for infra/live/demo/platform's
# tests to catch the one failure that matters here: the root silently not
# passing its opt-in, leaving this secret on the 30-day window while the root's
# own secret looks fixed - which is the trap half-closed, and looks closed.
output "secret_recovery_window_in_days" {
  description = "Recovery window in force on the client-secret secret. 0 means a destroy deletes it immediately and unrecoverably and the name frees up at once; 7-30 means a destroy only schedules it and the name stays reserved for that long, so a same-name re-apply inside the window fails."
  value       = aws_secretsmanager_secret.this.recovery_window_in_days
}

output "scope" {
  description = "Full OAuth scope string (\"identifier/scope_name\")."
  value       = local.scope
}

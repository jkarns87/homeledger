variable "name" {
  type        = string
  description = "Name for the Cognito user pool."
}

variable "domain_prefix" {
  type        = string
  description = "Cognito Hosted UI domain prefix. Must be globally unique within the region."
}

variable "resource_server_identifier" {
  type        = string
  description = "Identifier for the Cognito resource server (the API's audience / scope namespace)."
}

variable "scope_name" {
  type        = string
  description = "OAuth scope name registered on the resource server."
}

variable "scope_description" {
  type        = string
  description = "Human-readable description of the OAuth scope."
}

variable "client_name" {
  type        = string
  description = "Name for the client-credentials app client."
}

variable "access_token_validity_minutes" {
  type        = number
  description = "Access token validity, in minutes."
  default     = 60

  validation {
    condition     = var.access_token_validity_minutes >= 5 && var.access_token_validity_minutes <= 1440
    error_message = "access_token_validity_minutes must be between 5 and 1440."
  }
}

variable "secret_name" {
  type        = string
  description = "Name for the Secrets Manager secret that holds the client secret."
}

variable "recovery_window_in_days" {
  type        = number
  description = "Days Secrets Manager waits before permanently deleting the client-secret secret on a destroy. 30 is AWS's default and the production-safe answer: the value stays restorable, but the name also stays reserved for the whole window, so a same-name re-apply inside it fails. 0 forces immediate, unrecoverable deletion and frees the name, which is correct only for a disposable environment that re-applies the same names. See the comment on aws_secretsmanager_secret.this."
  default     = 30

  validation {
    condition     = var.recovery_window_in_days == 0 || (var.recovery_window_in_days >= 7 && var.recovery_window_in_days <= 30)
    error_message = "recovery_window_in_days must be 0 (immediate, unrecoverable deletion) or between 7 and 30. AWS rejects 1-6."
  }
}

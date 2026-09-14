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

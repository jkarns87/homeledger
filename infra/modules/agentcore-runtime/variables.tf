variable "name" {
  type        = string
  description = "AgentCore runtime name. AgentCore restricts this to letters, digits, and underscores."

  validation {
    condition     = can(regex("^[A-Za-z][A-Za-z0-9_]*$", var.name))
    error_message = "name must start with a letter and contain only letters, digits, and underscores."
  }
}

variable "image_uri" {
  type        = string
  description = "Full ECR image URI with tag. Empty string means no image is available yet, so the runtime is not created (count = 0)."
  default     = ""
}

variable "role_name" {
  type        = string
  description = "Name for the IAM execution role created for the runtime."
}

variable "ecr_repository_arn" {
  type        = string
  description = "ARN of the ECR repository the runtime pulls its container image from."
}

variable "dynamodb_table_arn" {
  type        = string
  description = "ARN of the DynamoDB table the runtime is granted access to (table and its GSIs)."
}

variable "environment_variables" {
  type        = map(string)
  description = "Environment variables injected into the runtime container."
  default     = {}
}

variable "jwt_discovery_url" {
  type        = string
  description = "OIDC discovery URL for the custom JWT authorizer (Cognito user pool .well-known/openid-configuration)."
}

variable "jwt_allowed_client_ids" {
  type        = list(string)
  description = "Client IDs the custom JWT authorizer accepts."
}

variable "idle_session_timeout_seconds" {
  type        = number
  description = "Idle runtime session timeout, in seconds."

  validation {
    condition     = var.idle_session_timeout_seconds >= 60 && var.idle_session_timeout_seconds <= 28800
    error_message = "idle_session_timeout_seconds must be between 60 and 28800."
  }
}

variable "max_lifetime_seconds" {
  type        = number
  description = "Maximum runtime session lifetime, in seconds, before AgentCore forcibly recycles it."
  default     = 28800

  validation {
    condition     = var.max_lifetime_seconds >= 60 && var.max_lifetime_seconds <= 28800
    error_message = "max_lifetime_seconds must be between 60 and 28800."
  }
}

variable "network_mode" {
  type        = string
  description = "AgentCore Runtime network mode."
  default     = "PUBLIC"

  validation {
    condition     = contains(["PUBLIC", "VPC"], var.network_mode)
    error_message = "network_mode must be PUBLIC or VPC."
  }
}

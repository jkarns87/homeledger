variable "name_prefix" {
  type        = string
  description = "Prefix for every resource name, e.g. demo-homeledger."
}

variable "household_id" {
  type        = string
  description = "The one household the linked Ring account maps to (spec §3)."
}

variable "table_name" {
  type        = string
  description = "HomeLedger DynamoDB table name."
}

variable "table_arn" {
  type        = string
  description = "HomeLedger DynamoDB table ARN."
}

variable "artifacts_dir" {
  type        = string
  description = "Directory holding apps/events' built bundles, one sub-directory per handler with an index.mjs."
}

variable "ring_client_id" {
  type        = string
  description = "Ring app Client ID. Not a secret (spec §3). Empty until the repository variable is set; the token-exchange and token-refresh functions fail loudly without it."
  default     = ""
}

variable "ring_client_secret_arn" {
  type        = string
  description = "ARN of the owner-created secret holding the Ring client secret."
}

variable "ring_hmac_key_arn" {
  type        = string
  description = "ARN of the owner-created secret holding the Ring HMAC signature key."
}

variable "anthropic_key_arn" {
  type        = string
  description = "ARN of the owner-created secret holding the Anthropic API key used to describe snapshots."
}

variable "link_passphrase_arn" {
  type        = string
  description = "ARN of the owner-created secret holding the household passphrase the Account Link page asks for (R1)."
}

variable "cognito_user_pool_id" {
  type        = string
  description = "User pool that issues the simulator's client-credentials token; the WebSocket authorizer verifies against it."
}

variable "cognito_client_id" {
  type        = string
  description = "App client whose tokens may open a push connection."
}

variable "sensors_enabled" {
  type        = bool
  description = "Spec §6 flag: gates the live sensor path, independently of the doorbell path."
  default     = true
}

variable "sensor_appliance_id" {
  type        = string
  description = "Appliance whose inspection a flood or freeze opens or advances (R12)."
  default     = "appl_waterheater22222"
  validation {
    condition     = can(regex("^appl_[a-z2-7]{16}$", var.sensor_appliance_id))
    error_message = "sensor_appliance_id must be an appliance id, appl_ followed by 16 base32 characters."
  }
}

variable "sensor_poll_minutes" {
  type        = number
  description = "Minutes between reconciliation polls of sensor status (spec §6, default 2)."
  default     = 2
  validation {
    condition     = var.sensor_poll_minutes >= 1 && var.sensor_poll_minutes <= 60 && floor(var.sensor_poll_minutes) == var.sensor_poll_minutes
    error_message = "sensor_poll_minutes must be a whole number from 1 to 60."
  }
}

variable "anthropic_model" {
  type        = string
  description = "Model that describes a snapshot (spec §5)."
  default     = "claude-sonnet-5"
}

variable "log_retention_days" {
  type        = number
  description = "CloudWatch retention for every function's log group."
  default     = 14
}

variable "secret_recovery_window_in_days" {
  type        = number
  description = "Recovery window for the tokens secret this module creates. 0 deletes immediately (demo); otherwise 7-30."
  default     = 0
  validation {
    condition     = var.secret_recovery_window_in_days == 0 || (var.secret_recovery_window_in_days >= 7 && var.secret_recovery_window_in_days <= 30)
    error_message = "secret_recovery_window_in_days must be 0 or between 7 and 30."
  }
}

variable "snapshot_bucket_force_destroy" {
  type        = bool
  description = "Whether terraform destroy may delete a snapshot bucket that still holds images."
  default     = true
}
